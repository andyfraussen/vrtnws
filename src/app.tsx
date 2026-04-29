import figlet from 'figlet';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useApp, useInput, useStdout} from 'ink';
import openExternal from 'open';
import {COLORS, FEED_URL, SPORZA_FEED_URL} from './constants.js';
import {fetchArticleBody, fetchFeed} from './feed.js';
import {TerminalImage} from './terminal-image.js';
import type {Article} from './types.js';

type Tab = 'news' | 'sport';
type Screen = 'list' | 'detail' | 'help';
type HeaderLine = {
	vrt: string;
	nws: string;
};

type FeedState = {
	loading: boolean;
	refreshing: boolean;
	error?: string;
	articles: Article[];
	lastUpdated?: Date;
};

const EMPTY_FEED: FeedState = {
	loading: false,
	refreshing: false,
	articles: [],
};
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const TABS: Tab[] = ['news', 'sport'];

const TAB_LABELS: Record<Tab, string> = {
	news: 'Nieuws',
	sport: 'Sport',
};

const TAB_URLS: Record<Tab, string> = {
	news: FEED_URL,
	sport: SPORZA_FEED_URL,
};

export function App() {
	const {exit} = useApp();
	const {stdout} = useStdout();
	const columns = stdout.columns ?? 100;
	const rows = stdout.rows ?? 32;

	const [screen, setScreen] = useState<Screen>('list');
	const [tab, setTab] = useState<Tab>('news');
	const [feeds, setFeeds] = useState<Record<Tab, FeedState>>({
		news: EMPTY_FEED,
		sport: EMPTY_FEED,
	});
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [detailOffset, setDetailOffset] = useState(0);
	const [activeArticle, setActiveArticle] = useState<Article | null>(null);
	const [bodyState, setBodyState] = useState<{loading: boolean; body: string[]}>({
		loading: false,
		body: [],
	});
	const [notice, setNotice] = useState('');
	const inFlightFeeds = useRef(new Set<Tab>());

	const activeFeed = feeds[tab];
	const visibleCount = Math.max(3, Math.floor((rows - 12) / 4));
	const activeArticles = activeFeed.articles;
	const detailMaxLineLength = Math.max(40, Math.min(100, columns - 6));
	const detailAvailableLines = Math.max(4, rows - (activeArticle?.imageUrl ? 21 : 12));
	const detailLineCount = useMemo(
		() => buildArticleLines(bodyState.body, detailMaxLineLength).length,
		[bodyState.body, detailMaxLineLength],
	);
	const maxDetailOffset = Math.max(0, detailLineCount - detailAvailableLines);

	const loadFeed = useCallback((targetTab: Tab, manual = false) => {
		if (inFlightFeeds.current.has(targetTab)) {
			return;
		}

		inFlightFeeds.current.add(targetTab);

		setFeeds((current) => ({
			...current,
			[targetTab]: {
				...current[targetTab],
				error: undefined,
				loading: current[targetTab].articles.length === 0,
				refreshing: current[targetTab].articles.length > 0,
			},
		}));

		void fetchFeed(TAB_URLS[targetTab])
			.then((articles) => {
				setFeeds((current) => ({
					...current,
					[targetTab]: {
						loading: false,
						refreshing: false,
						articles,
						lastUpdated: new Date(),
					},
				}));

				if (manual) {
					setNotice(`${TAB_LABELS[targetTab]} vernieuwd`);
				}
			})
			.catch((error: unknown) => {
				setFeeds((current) => ({
					...current,
					[targetTab]: {
						loading: false,
						refreshing: false,
						articles: current[targetTab].articles,
						error: error instanceof Error ? error.message : 'Onbekende fout',
						lastUpdated: current[targetTab].lastUpdated,
					},
				}));

				if (manual) {
					setNotice(`${TAB_LABELS[targetTab]} kon niet vernieuwen`);
				}
			})
			.finally(() => {
				inFlightFeeds.current.delete(targetTab);
			});
	}, []);

	useEffect(() => {
		if (feeds[tab].loading || feeds[tab].refreshing || feeds[tab].articles.length > 0 || feeds[tab].error) {
			return;
		}

		loadFeed(tab);
	}, [feeds, loadFeed, tab]);

	useEffect(() => {
		const interval = setInterval(() => {
			for (const targetTab of TABS) {
				loadFeed(targetTab);
			}
		}, AUTO_REFRESH_MS);

		return () => {
			clearInterval(interval);
		};
	}, [loadFeed]);

	useEffect(() => {
		setSelectedIndex((current) => {
			if (activeArticles.length === 0) {
				return 0;
			}

			return Math.min(current, activeArticles.length - 1);
		});
	}, [activeArticles.length]);

	useEffect(() => {
		if (!activeArticle || screen !== 'detail') {
			return;
		}

		let active = true;
		setBodyState({loading: true, body: []});

		void fetchArticleBody(activeArticle.link)
			.then((body) => {
				if (active) {
					setBodyState({loading: false, body});
				}
			})
			.catch(() => {
				if (active) {
					setBodyState({loading: false, body: []});
				}
			});

		return () => {
			active = false;
		};
	}, [activeArticle, screen]);

	useEffect(() => {
		if (!notice) {
			return;
		}

		const timeout = setTimeout(() => {
			setNotice('');
		}, 2500);

		return () => {
			clearTimeout(timeout);
		};
	}, [notice]);

	useInput((input, key) => {
		if (input === 'q') {
			exit();
			return;
		}

		if (screen === 'help') {
			if (key.escape || input === 'h') {
				setScreen('list');
			}

			return;
		}

		if (input === 'h') {
			setScreen('help');
			return;
		}

		if (input === 'r') {
			loadFeed(tab, true);
			return;
		}

		if (screen === 'detail') {
			if (key.escape || input === 'b') {
				setScreen('list');
				setActiveArticle(null);
				setDetailOffset(0);
				return;
			}

			if (input === 'o' && activeArticle?.link) {
				void openExternal(activeArticle.link);
				setNotice('Opent in browser...');
				return;
			}

			if (key.downArrow || input === 'j') {
				setDetailOffset((current) => Math.min(maxDetailOffset, current + 1));
				return;
			}

			if (key.upArrow || input === 'k') {
				setDetailOffset((current) => Math.max(0, current - 1));
				return;
			}

			return;
		}

		if (key.tab || key.rightArrow || key.leftArrow) {
			setTab((current) => (current === 'news' ? 'sport' : 'news'));
			setSelectedIndex(0);
			return;
		}

		if (key.downArrow || input === 'j') {
			if (activeArticles.length === 0) {
				return;
			}

			const next = Math.min(activeArticles.length - 1, selectedIndex + 1);
			setSelectedIndex(next);
			return;
		}

		if (key.upArrow || input === 'k') {
			if (activeArticles.length === 0) {
				return;
			}

			const next = Math.max(0, selectedIndex - 1);
			setSelectedIndex(next);
			return;
		}

		if (key.return || input === 'o') {
			const article = activeArticles[selectedIndex];

			if (article) {
				setBodyState({loading: true, body: []});
				setActiveArticle(article);
				setScreen('detail');
				setDetailOffset(0);
			}
		}
	});

	const header = useMemo(() => buildHeader(), []);

	return (
		<Box flexDirection="column">
			<BrandHeader header={header} />
			{screen === 'help' ? (
				<HelpScreen />
			) : screen === 'detail' && activeArticle ? (
				<DetailScreen
					article={activeArticle}
					body={bodyState.body}
					bodyLoading={bodyState.loading}
					columns={columns}
					detailOffset={detailOffset}
					rows={rows}
				/>
			) : (
				<ListScreen
					feed={activeFeed}
					selectedIndex={selectedIndex}
					tab={tab}
					visibleCount={visibleCount}
				/>
			)}
			<Footer screen={screen} notice={notice} />
		</Box>
	);
}

function BrandHeader({header}: {header: HeaderLine[]}) {
	return (
		<Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="single" borderColor={COLORS.border}>
			{header.map((line, index) => (
				<Text key={index} bold>
					<Text>{line.vrt}</Text>
					<Text>   </Text>
					<Text color={COLORS.purple}>{line.nws}</Text>
				</Text>
			))}
		</Box>
	);
}

function ListScreen({
	feed,
	selectedIndex,
	tab,
	visibleCount,
}: {
	feed: FeedState;
	selectedIndex: number;
	tab: Tab;
	visibleCount: number;
}) {
	const listOffset = centeredOffset(selectedIndex, visibleCount, feed.articles.length);
	const visibleArticles = feed.articles.slice(listOffset, listOffset + visibleCount);
	const hasArticlesAbove = listOffset > 0;
	const hasArticlesBelow = listOffset + visibleCount < feed.articles.length;

	return (
		<Box flexDirection="column" paddingX={2}>
			<Box gap={2} marginY={1}>
				<TabLabel active={tab === 'news'} label={TAB_LABELS.news} />
				<TabLabel active={tab === 'sport'} label={TAB_LABELS.sport} />
			</Box>

			{feed.loading ? <Text color={COLORS.purple}>Feed laden...</Text> : null}
			{feed.refreshing ? <Text color={COLORS.muted}>Feed vernieuwen...</Text> : null}
			{feed.error ? <Text color={COLORS.purple}>Kon feed niet laden: {feed.error}</Text> : null}
			{feed.lastUpdated ? <Text color={COLORS.muted}>Laatst bijgewerkt: {formatTime(feed.lastUpdated)}</Text> : null}

			{!feed.loading && feed.articles.length > 0 ? (
				<>
					{hasArticlesAbove ? <Text color={COLORS.muted}>↑ {listOffset} artikels boven</Text> : null}
					{visibleArticles.map((article, index) => {
							const absoluteIndex = listOffset + index;

							return (
								<ArticleCard
									key={`${article.link}-${absoluteIndex}`}
									article={article}
									selected={absoluteIndex === selectedIndex}
								/>
							);
						})}
					{hasArticlesBelow ? (
						<Text color={COLORS.muted}>↓ {feed.articles.length - listOffset - visibleCount} artikels verder</Text>
					) : null}
				</>
			) : null}
		</Box>
	);
}

function TabLabel({active, label}: {active: boolean; label: string}) {
	return (
		<Text color={active ? COLORS.purple : COLORS.muted} bold={active}>
			{active ? '●' : '○'} {label}
		</Text>
	);
}

function ArticleCard({article, selected}: {article: Article; selected: boolean}) {
	const meta = [article.pubDate.split(' · ')[0], article.category.toUpperCase()].filter(Boolean).join(' · ');

	return (
		<Box
			flexDirection="column"
			borderStyle={selected ? 'single' : undefined}
			borderColor={selected ? COLORS.purple : undefined}
			paddingX={1}
			marginBottom={1}
		>
			{meta ? (
				<Text color={COLORS.purple} bold>
					{meta}
				</Text>
			) : null}
			<Text bold wrap="truncate-end">
				{article.title}
			</Text>
			{article.summary ? <Text>{truncate(article.summary, 160)}</Text> : null}
		</Box>
	);
}

function DetailScreen({
	article,
	body,
	bodyLoading,
	columns,
	detailOffset,
	rows,
}: {
	article: Article;
	body: string[];
	bodyLoading: boolean;
	columns: number;
	detailOffset: number;
	rows: number;
}) {
	const maxLineLength = Math.max(40, Math.min(100, columns - 6));
	const articleLines = buildArticleLines(body, maxLineLength);
	const availableLines = Math.max(4, rows - (article.imageUrl ? 21 : 12));
	const maxOffset = Math.max(0, articleLines.length - availableLines);
	const safeOffset = Math.min(detailOffset, maxOffset);
	const visibleBody = articleLines.slice(safeOffset, safeOffset + availableLines);
	const hasBodyAbove = safeOffset > 0;
	const hasBodyBelow = safeOffset + availableLines < articleLines.length;

	return (
		<Box flexDirection="column" paddingX={2} paddingY={1}>
			<Box justifyContent="space-between">
				<Text bold>
					← ESC · Terug
				</Text>
				<Text color={COLORS.muted}>O · Open in browser</Text>
			</Box>

			{article.category ? (
				<Text color={COLORS.purple} bold>
					{article.category.toUpperCase()}
				</Text>
			) : null}
			{article.pubDate ? <Text color={COLORS.muted}>{article.pubDate}</Text> : null}

			<Box marginTop={1}>
				<Text bold>
					{article.title}
				</Text>
			</Box>

			{article.imageUrl ? (
				<TerminalImage
					url={article.imageUrl}
					maxColumns={Math.max(20, columns - 6)}
					maxRows={Math.max(4, Math.min(12, Math.floor(rows / 3)))}
				/>
			) : null}

			{bodyLoading ? <Text color={COLORS.muted}>Artikel laden...</Text> : null}
			{!bodyLoading && body.length === 0 ? (
				<Text color={COLORS.soft}>Volledige tekst niet beschikbaar. Druk O om in browser te openen.</Text>
			) : null}

			{hasBodyAbove ? <Text color={COLORS.muted}>↑ meer tekst boven</Text> : null}

			{visibleBody.map((line, index) => {
				if (line.kind === 'blank') {
					return <Text key={`${safeOffset}-${index}`}> </Text>;
				}

				if (line.kind === 'heading') {
					return (
						<Text key={`${safeOffset}-${index}`} color={COLORS.purple} bold>
							{line.text}
						</Text>
					);
				}

				return <Text key={`${safeOffset}-${index}`}>{line.text}</Text>;
			})}

			{hasBodyBelow ? <Text color={COLORS.muted}>↓ meer tekst onder</Text> : null}
		</Box>
	);
}

function HelpScreen() {
	return (
		<Box flexDirection="column" paddingX={3} paddingY={1}>
			<Text color={COLORS.purple} bold>
				Toetsen
			</Text>
			<Text>↑ / ↓      Navigeer door artikels</Text>
			<Text>j / k      Navigeer of scroll</Text>
			<Text>Enter / o  Open artikel</Text>
			<Text>ESC / b    Terug naar lijst</Text>
			<Text>o          Open artikel in browser vanuit detail</Text>
			<Text>Tab        Switch tussen Nieuws en Sport</Text>
			<Text>r          Vernieuw feed</Text>
			<Text>h          Toon deze help</Text>
			<Text>q          Afsluiten</Text>
		</Box>
	);
}

function Footer({screen, notice}: {screen: Screen; notice: string}) {
	const text =
		notice ||
		(screen === 'detail'
			? 'j/k ↑↓ scrollen · r vernieuwen · ESC terug · O browser · q stop'
			: screen === 'help'
				? 'ESC sluiten · q stop'
				: 'j/k ↑↓ navigeren · Enter/o openen · r vernieuwen · Tab sectie · h help · q stop');

	return (
		<Box borderStyle="single" borderColor={COLORS.border} paddingX={2}>
			<Text color={notice ? COLORS.purple : COLORS.muted}>{text}</Text>
		</Box>
	);
}

function buildHeader(): HeaderLine[] {
	const vrt = figlet.textSync('VRT', {font: 'Small'}).trimEnd().split('\n');
	const nws = figlet.textSync('NWS', {font: 'Small'}).trimEnd().split('\n');
	const height = Math.max(vrt.length, nws.length);
	const width = Math.max(...vrt.map((line) => line.length));
	const lines: HeaderLine[] = [];

	for (let index = 0; index < height; index += 1) {
		lines.push({
			vrt: (vrt[index] ?? '').padEnd(width),
			nws: nws[index] ?? '',
		});
	}

	return lines;
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength - 1)}…`;
}

function formatTime(date: Date): string {
	return new Intl.DateTimeFormat('nl-BE', {
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

function centeredOffset(selectedIndex: number, visibleCount: number, total: number): number {
	if (total <= visibleCount) {
		return 0;
	}

	const midpoint = Math.floor(visibleCount / 2);
	const rawOffset = selectedIndex - midpoint;

	return Math.max(0, Math.min(rawOffset, total - visibleCount));
}

type ArticleLine =
	| {kind: 'blank'}
	| {kind: 'heading'; text: string}
	| {kind: 'text'; text: string};

function buildArticleLines(paragraphs: string[], maxLineLength: number): ArticleLine[] {
	const lines: ArticleLine[] = [];

	for (const paragraph of paragraphs) {
		if (paragraph.startsWith('[') && paragraph.endsWith(']')) {
			lines.push({kind: 'blank'});
			lines.push({kind: 'heading', text: paragraph.slice(1, -1)});
			continue;
		}

		if (lines.length > 0) {
			lines.push({kind: 'blank'});
		}

		for (const line of wrapText(paragraph, maxLineLength)) {
			lines.push({kind: 'text', text: line});
		}
	}

	return lines;
}

function wrapText(value: string, maxLineLength: number): string[] {
	const words = value.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = '';

	for (const word of words) {
		if (!current) {
			current = word;
			continue;
		}

		if (`${current} ${word}`.length > maxLineLength) {
			lines.push(current);
			current = word;
			continue;
		}

		current = `${current} ${word}`;
	}

	if (current) {
		lines.push(current);
	}

	return lines;
}
