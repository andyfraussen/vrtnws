#!/usr/bin/env python3
"""VRT NWS — terminal reader."""

from __future__ import annotations

import json
import re
import webbrowser
from dataclasses import dataclass, field
from datetime import datetime
from io import BytesIO
from typing import ClassVar

import httpx
import feedparser
import pyfiglet
from bs4 import BeautifulSoup
from PIL import Image as PILImage
from rich.text import Text as RichText
from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, VerticalScroll
from textual.screen import Screen
from textual.widget import Widget
from textual.widgets import (
    Footer,
    Label,
    ListItem,
    ListView,
    LoadingIndicator,
    Static,
    TabbedContent,
    TabPane,
)


# ── Feed ───────────────────────────────────────────────────────────────────────

FEED_URL        = "https://www.vrt.be/vrtnws/nl.rss.articles.xml"
SPORZA_FEED_URL = "https://sporza.be/nl.rss.articles.xml"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}

# ── Brand colors ───────────────────────────────────────────────────────────────
# VRT NWS palette: near-black bg, white "VRT", purple "NWS"
PURPLE   = "#7B5EA7"   # NWS pill / active accent
PURPLE_D = "#4A3870"   # darker purple for borders / hover
BG       = "#0D0D12"   # near-black background
BG_CARD  = "#121218"   # card background
BG_SEL   = "#0F0C1E"   # selected card tint
NAVY     = "#0D1020"   # header background
NAVY_B   = "#1C1A30"   # header border


# ── Brand header ───────────────────────────────────────────────────────────────

def _build_brand_lines() -> list[RichText]:
    font = "small"
    vrt_raw = pyfiglet.figlet_format("VRT", font=font).splitlines()
    nws_raw = pyfiglet.figlet_format("NWS", font=font).splitlines()

    while vrt_raw and not vrt_raw[-1].strip(): vrt_raw.pop()
    while nws_raw and not nws_raw[-1].strip(): nws_raw.pop()

    h = max(len(vrt_raw), len(nws_raw))
    vrt_raw += [""] * (h - len(vrt_raw))
    nws_raw += [""] * (h - len(nws_raw))
    vrt_w = max((len(l) for l in vrt_raw), default=0)

    lines: list[RichText] = []
    for v, n in zip(vrt_raw, nws_raw):
        line = RichText(no_wrap=True, overflow="crop")
        line.append(v.ljust(vrt_w), style="bold #FFFFFF")
        line.append("   ")
        line.append(n, style=f"bold {PURPLE}")
        lines.append(line)
    return lines


BRAND_LINES = _build_brand_lines()


# ── Data ───────────────────────────────────────────────────────────────────────

@dataclass
class Article:
    title:       str
    summary:     str
    link:        str
    pub_date:    str
    pub_dt:      datetime
    category:    str
    image_url:   str | None = None
    body:        list[str] = field(default_factory=list)


def _parse_feed(xml: str) -> list[Article]:
    feed = feedparser.parse(xml)
    articles: list[Article] = []
    for entry in feed.entries:
        pub_dt = datetime.min
        pub_date = ""
        if getattr(entry, "published_parsed", None):
            try:
                pub_dt = datetime(*entry.published_parsed[:6])
                pub_date = pub_dt.strftime("%H:%M · %d/%m/%Y")
            except Exception:
                pass

        summary = re.sub(r"<[^>]+>", "", getattr(entry, "summary", "") or "").strip()

        link = next(
            (l["href"] for l in getattr(entry, "links", []) if l.get("rel") == "alternate"),
            getattr(entry, "link", ""),
        )

        image_url = next(
            (l["href"] for l in getattr(entry, "links", [])
             if l.get("rel") == "enclosure" and "image" in l.get("type", "")),
            None,
        )
        # Fallback: media:content (used by Sporza)
        if not image_url:
            for mc in getattr(entry, "media_content", []):
                if "image" in mc.get("type", "") or mc.get("url", "").endswith((".jpg", ".jpeg", ".png", ".gif", ".webp")):
                    image_url = mc.get("url")
                    break

        category = (getattr(entry, "vrtns_nstag", "") or "").split("|")[0].strip()
        if not category and getattr(entry, "tags", None):
            category = entry.tags[0].term.split("|")[0].strip()

        articles.append(Article(
            title=entry.title,
            summary=summary,
            link=link,
            pub_date=pub_date,
            pub_dt=pub_dt,
            category=category,
            image_url=image_url,
        ))

    articles.sort(key=lambda a: a.pub_dt, reverse=True)
    return articles


def _fetch_article_body(url: str) -> list[str]:
    """Fetch article body paragraphs via JSON-LD structured data."""
    try:
        with httpx.Client(headers=HEADERS, timeout=10, follow_redirects=True) as c:
            resp = c.get(url)
        soup = BeautifulSoup(resp.text, "html.parser")

        paragraphs: list[str] = []
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "")
                if isinstance(data, list):
                    items = data
                elif isinstance(data, dict) and "@graph" in data:
                    items = data["@graph"]
                else:
                    items = [data]

                for item in items:
                    t = item.get("@type", "")
                    if t in ("NewsArticle", "Article", "ReportageNewsArticle"):
                        body = item.get("articleBody", "")
                        if body:
                            for para in re.split(r"\n{2,}", body.strip()):
                                para = para.strip()
                                if para:
                                    paragraphs.append(para)
                        break
                    elif t == "LiveBlogPosting":
                        for update in item.get("liveBlogUpdate", []):
                            headline = update.get("headline", "")
                            body = update.get("articleBody", "")
                            if headline:
                                paragraphs.append(f"[{headline}]")
                            for para in re.split(r"\n{2,}", body.strip()):
                                para = para.strip()
                                if para:
                                    paragraphs.append(para)
                        break

                if paragraphs:
                    break
            except Exception:
                continue

        if paragraphs:
            return paragraphs

        # Fallback: raw <p> tags
        for selector in ("article", "main", '[class*="article-body"]'):
            container = soup.select_one(selector)
            if container:
                for p in container.find_all("p"):
                    text = p.get_text(strip=True)
                    if len(text) > 40:
                        paragraphs.append(text)
                if paragraphs:
                    return paragraphs
    except Exception:
        pass
    return []


# ── Image rendering ────────────────────────────────────────────────────────────

def _fetch_pil(url: str) -> PILImage.Image | None:
    try:
        raw = httpx.get(url, headers=HEADERS, timeout=8).content
        return PILImage.open(BytesIO(raw)).convert("RGB")
    except Exception:
        return None


def _render_image(img: PILImage.Image, max_cols: int, max_rows: int) -> RichText:
    """Render a PIL image as half-block Unicode characters (▀)."""
    orig_w, orig_h = img.size
    # Each terminal row = 2 pixel rows (▀ top + background bottom)
    # Terminal cells are roughly square when using half-blocks, so no aspect correction needed
    scale = min(max_cols / orig_w, (max_rows * 2) / orig_h)
    new_w = max(1, int(orig_w * scale))
    new_h = max(2, int(orig_h * scale))
    new_h += new_h % 2

    img = img.resize((new_w, new_h), PILImage.LANCZOS)
    px = img.load()

    result = RichText(no_wrap=True)
    for y in range(0, new_h, 2):
        for x in range(new_w):
            top    = px[x, y]
            bottom = px[x, y + 1] if y + 1 < new_h else (0, 0, 0)
            fg = f"rgb({top[0]},{top[1]},{top[2]})"
            bg = f"rgb({bottom[0]},{bottom[1]},{bottom[2]})"
            result.append("▀", style=f"{fg} on {bg}")
        result.append("\n")
    return result


class TermImage(Widget):
    """Renders a PIL image using Unicode half-block characters."""

    DEFAULT_CSS = "TermImage { height: auto; width: 1fr; }"

    def __init__(self, img: PILImage.Image, max_cols: int = 56, max_rows: int = 10) -> None:
        super().__init__()
        self._rendered = _render_image(img, max_cols, max_rows)

    def render(self) -> RichText:
        return self._rendered


# ── CSS ────────────────────────────────────────────────────────────────────────

APP_CSS = f"""
Screen {{
    background: {BG};
}}

BrandHeader {{
    background: {NAVY};
    border-bottom: tall {NAVY_B};
    padding: 1 2;
    height: auto;
    overflow: hidden hidden;
    align: left middle;
}}

TabbedContent {{ height: 1fr; }}

Tabs {{
    background: {BG};
    border-bottom: tall #1A1A25;
}}

Tab {{ color: #2E2E42; padding: 0 2; }}
Tab.-active {{ color: {PURPLE}; text-style: bold; }}
Tab:hover {{ color: #8888AA; }}

TabPane {{ padding: 0; background: {BG}; }}

FeedView {{ height: 1fr; background: {BG}; }}

ListView {{
    background: transparent;
    border: none;
    padding: 1 0;
}}

ListItem {{
    height: auto;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
}}

.article-card {{
    background: {BG_CARD};
    margin: 0 2 1 2;
    padding: 0;
    border-left: thick #1E1E2E;
    height: auto;
}}

ListItem.-highlight .article-card {{
    background: {BG_SEL};
    border-left: thick {PURPLE};
}}

.card-text {{
    padding: 1 2;
    height: auto;
}}

.article-meta {{
    color: {PURPLE};
    text-style: bold;
}}

.article-title {{
    color: #F0EBE1;
    text-style: bold;
    margin-top: 1;
}}

.article-summary {{
    color: #484860;
    margin-top: 1;
}}

LoadingIndicator {{
    color: {PURPLE};
    background: {BG};
    height: 1fr;
}}

.error-msg {{ color: {PURPLE}; margin: 2 4; }}

/* Article detail */
#detail-bar {{
    height: 3;
    background: {NAVY};
    align: left middle;
    padding: 0 2;
    border-bottom: tall {NAVY_B};
}}

#detail-back {{ color: #FFFFFF; text-style: bold; width: auto; }}

#detail-browser-hint {{
    color: #666688;
    dock: right;
    margin-right: 1;
    width: auto;
}}

#detail-scroll {{ padding: 1 3; background: {BG}; }}
#detail-category {{ color: {PURPLE}; text-style: bold; }}
#detail-date {{ color: #2E2E42; margin-top: 1; }}

#detail-title {{
    color: #F0EBE1;
    text-style: bold;
    margin-top: 2;
    margin-bottom: 1;
}}

#detail-image {{ margin: 1 0 2 0; width: 1fr; overflow: hidden hidden; }}
#detail-image-loading {{ color: #2E2E42; margin: 1 0; }}

.detail-rule {{ background: #1A1A25; height: 1; margin: 1 0; }}
#detail-summary {{ color: #888899; text-style: italic; width: 1fr; }}

.body-para {{
    color: #CCCCDD;
    margin-bottom: 1;
    width: 1fr;
}}

.body-heading {{
    color: {PURPLE};
    text-style: bold;
    margin-top: 1;
    margin-bottom: 1;
    width: 1fr;
}}

#body-loading {{
    color: #2E2E42;
    margin-top: 1;
}}

#detail-open-hint {{
    color: #2A2A3A;
    margin-top: 3;
    border-top: solid #1A1A25;
    padding-top: 1;
}}

Footer {{ background: #0A0A0F; color: #2E2E42; }}
"""

HELP_TEXT = f"""
[bold {PURPLE}]Toetsen[/]

  [bold]↑ / ↓[/]      Navigeer door artikels
  [bold]Enter[/]      Open artikel
  [bold]ESC / b[/]    Terug naar lijst
  [bold]O[/]          Open artikel in browser
  [bold]h[/]          Toon deze help
  [bold]q[/]          Afsluiten
"""


# ── Widgets ────────────────────────────────────────────────────────────────────

class BrandHeader(Widget):
    DEFAULT_CSS = ""

    def render(self) -> RichText:
        result = RichText(no_wrap=True, overflow="crop")
        for i, line in enumerate(BRAND_LINES):
            result.append_text(line)
            if i < len(BRAND_LINES) - 1:
                result.append("\n")
        return result


class ArticleCard(Widget):
    DEFAULT_CSS = "ArticleCard { height: auto; }"

    def __init__(self, article: Article) -> None:
        super().__init__(classes="article-card")
        self.article = article

    def compose(self) -> ComposeResult:
        a = self.article
        with Container(classes="card-text"):
            parts = []
            if a.pub_date:
                parts.append(a.pub_date.split(" · ")[0])
            if a.category:
                parts.append(a.category.upper())
            if parts:
                yield Label(" · ".join(parts), classes="article-meta")
            yield Label(a.title, classes="article-title")
            if a.summary:
                snippet = a.summary[:160] + ("…" if len(a.summary) > 160 else "")
                yield Label(snippet, classes="article-summary")


class FeedView(Widget):
    DEFAULT_CSS = "FeedView { height: 1fr; }"

    def __init__(self, url: str) -> None:
        super().__init__()
        self._url = url
        self._articles: list[Article] = []

    def compose(self) -> ComposeResult:
        yield LoadingIndicator()

    def on_mount(self) -> None:
        self.load_feed()

    @work(exclusive=True, thread=True)
    def load_feed(self) -> None:
        try:
            with httpx.Client(headers=HEADERS, timeout=10) as c:
                resp = c.get(self._url)
            articles = _parse_feed(resp.text)
            self.app.call_from_thread(self._show, articles)
        except Exception as exc:
            self.app.call_from_thread(self._error, str(exc))

    def _show(self, articles: list[Article]) -> None:
        self._articles = articles
        items = [ListItem(ArticleCard(a)) for a in articles]
        self._replace(ListView(*items))

    def _error(self, msg: str) -> None:
        self._replace(Label(f"Kon feed niet laden: {msg}", classes="error-msg"))

    def _replace(self, new: Widget) -> None:
        for w in self.query(LoadingIndicator):
            w.remove()
        self.mount(new)

    @on(ListView.Selected)
    def on_selected(self, event: ListView.Selected) -> None:
        try:
            card = event.item.query_one(ArticleCard)
        except Exception:
            return
        self.app.push_screen(ArticleDetailScreen(card.article))


# ── Screens ────────────────────────────────────────────────────────────────────

class ArticleDetailScreen(Screen):
    BINDINGS = [
        Binding("escape", "go_back", "Terug"),
        Binding("b",      "go_back", "Terug", show=False),
        Binding("o",      "open_browser", "Open in browser"),
    ]

    def __init__(self, article: Article) -> None:
        super().__init__()
        self.article = article

    def compose(self) -> ComposeResult:
        a = self.article

        with Container(id="detail-bar"):
            yield Label("← ESC · Terug", id="detail-back")
            yield Label("O · Open in browser", id="detail-browser-hint")

        with VerticalScroll(id="detail-scroll"):
            if a.category:
                yield Label(a.category.upper(), id="detail-category")
            if a.pub_date:
                yield Label(a.pub_date, id="detail-date")
            yield Label(a.title, id="detail-title")
            if a.image_url:
                yield Label("Afbeelding laden…", id="detail-image-loading")
            yield Static("", classes="detail-rule")
            yield Label("Artikel laden…", id="body-loading")
            yield Label(
                "Druk op O om het volledige artikel in de browser te openen.",
                id="detail-open-hint",
            )

        yield Footer()

    def on_mount(self) -> None:
        self._load_content()

    @work(exclusive=True, thread=True)
    def _load_content(self) -> None:
        a = self.article
        img = _fetch_pil(a.image_url) if a.image_url else None
        body = _fetch_article_body(a.link) if a.link else []
        self.app.call_from_thread(self._show_content, img, body)

    def _show_content(self, img: PILImage.Image | None, body: list[str]) -> None:
        scroll = self.query_one("#detail-scroll", VerticalScroll)

        if img:
            try:
                placeholder = self.query_one("#detail-image-loading")
                w = max(20, self.size.width - 6)
                widget = TermImage(img, max_cols=w, max_rows=20)
                widget.id = "detail-image"
                placeholder.remove()
                scroll.mount(widget, after=self.query_one("#detail-title"))
            except Exception:
                pass
        else:
            try:
                self.query_one("#detail-image-loading").remove()
            except Exception:
                pass

        try:
            loading_label = self.query_one("#body-loading")
            if body:
                hint = self.query_one("#detail-open-hint")
                for para in body:
                    if para.startswith("[") and para.endswith("]"):
                        w = Label(para[1:-1], classes="body-heading")
                    else:
                        w = Label(para, classes="body-para")
                    scroll.mount(w, before=hint)
                loading_label.remove()
            else:
                loading_label.update("Volledige tekst niet beschikbaar. Druk O om in browser te openen.")
        except Exception:
            pass

    def action_go_back(self) -> None:
        self.app.pop_screen()

    def action_open_browser(self) -> None:
        webbrowser.open(self.article.link)
        self.notify("Opent in browser…", severity="information")


class HelpScreen(Screen):
    BINDINGS = [Binding("escape,h,q", "dismiss", "Sluiten")]

    def compose(self) -> ComposeResult:
        with Container(id="detail-bar"):
            yield Label("h · Help", id="detail-back")
            yield Label("ESC · Sluiten", id="detail-browser-hint")
        with VerticalScroll(id="detail-scroll"):
            yield Static(HELP_TEXT, markup=True)
        yield Footer()

    def action_dismiss(self) -> None:
        self.app.pop_screen()


# ── App ────────────────────────────────────────────────────────────────────────

class VrtNwsApp(App):
    CSS = APP_CSS
    TITLE = "VRT NWS"
    COMMANDS: ClassVar = set()

    BINDINGS = [
        Binding("q", "quit", "Afsluiten"),
        Binding("h", "show_help", "Help"),
        Binding("ctrl+backslash", "command_palette", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield BrandHeader()
        with TabbedContent():
            with TabPane("Nieuws"):
                yield FeedView(FEED_URL)
            with TabPane("Sport"):
                yield FeedView(SPORZA_FEED_URL)
        yield Footer()

    def action_show_help(self) -> None:
        self.push_screen(HelpScreen())


def main() -> None:
    VrtNwsApp().run()


if __name__ == "__main__":
    main()
