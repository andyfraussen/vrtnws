import {load} from 'cheerio';
import Parser from 'rss-parser';
import {HEADERS} from './constants.js';
import type {Article} from './types.js';

const parser = new Parser({
	customFields: {
		item: [
			['media:content', 'mediaContent'],
			['vrtns:nstag', 'vrtTag'],
		],
	},
});

type FeedItem = Parser.Item & {
	id?: string;
	mediaContent?: {$?: {url?: string; type?: string}} | Array<{$?: {url?: string; type?: string}}>;
	vrtTag?: string;
	enclosure?: {
		url?: string;
		type?: string;
	};
};

export async function fetchFeed(url: string): Promise<Article[]> {
	const response = await fetch(url, {headers: HEADERS});

	if (!response.ok) {
		throw new Error(`Feed returned ${response.status}`);
	}

	const xml = await response.text();
	const feed = await parser.parseString(xml);
	const images = imageLookupFromXml(xml);

	return feed.items
		.map((item) => toArticle(item as FeedItem, images))
		.sort((a, b) => b.pubTime - a.pubTime);
}

export async function fetchArticleBody(url: string): Promise<string[]> {
	const response = await fetch(url, {headers: HEADERS, redirect: 'follow'});

	if (!response.ok) {
		return [];
	}

	const html = await response.text();
	const $ = load(html);
	const paragraphs: string[] = [];

	for (const element of $('script[type="application/ld+json"]').toArray()) {
		const raw = $(element).text();

		if (!raw.trim()) {
			continue;
		}

		try {
			const parsed = JSON.parse(raw) as unknown;
			const items = jsonLdItems(parsed);

			for (const item of items) {
				if (!isRecord(item)) {
					continue;
				}

				const type = item['@type'];

				if (type === 'NewsArticle' || type === 'Article' || type === 'ReportageNewsArticle') {
					const body = item.articleBody;

					if (typeof body === 'string') {
						paragraphs.push(...splitParagraphs(body));
					}

					break;
				}

				if (type === 'LiveBlogPosting' && Array.isArray(item.liveBlogUpdate)) {
					for (const update of item.liveBlogUpdate) {
						if (!isRecord(update)) {
							continue;
						}

						if (typeof update.headline === 'string' && update.headline.trim()) {
							paragraphs.push(`[${update.headline.trim()}]`);
						}

						if (typeof update.articleBody === 'string') {
							paragraphs.push(...splitParagraphs(update.articleBody));
						}
					}

					break;
				}
			}
		} catch {
			continue;
		}

		if (paragraphs.length > 0) {
			return paragraphs;
		}
	}

	for (const selector of ['article', 'main', '[class*="article-body"]']) {
		const container = $(selector).first();

		if (container.length === 0) {
			continue;
		}

		container.find('p').each((_, element) => {
			const text = $(element).text().replace(/\s+/g, ' ').trim();

			if (text.length > 40) {
				paragraphs.push(text);
			}
		});

		if (paragraphs.length > 0) {
			return paragraphs;
		}
	}

	return paragraphs;
}

function toArticle(item: FeedItem, images: Map<string, string>): Article {
	const published = item.isoDate ?? item.pubDate ?? '';
	const pubTime = published ? Date.parse(published) : 0;
	const pubDate = Number.isNaN(pubTime) || pubTime === 0 ? '' : formatDate(new Date(pubTime));
	const summary = stripHtml(item.contentSnippet ?? item.content ?? '');
	const link = item.link ?? '';

	return {
		title: item.title ?? 'Geen titel',
		summary,
		link,
		pubDate,
		pubTime,
		category: categoryFrom(item),
		imageUrl: imageFrom(item) ?? images.get(item.id ?? '') ?? images.get(link),
	};
}

function categoryFrom(item: FeedItem): string {
	if (typeof item.vrtTag === 'string' && item.vrtTag.trim()) {
		return item.vrtTag.split('|')[0]?.trim() ?? '';
	}

	const categories = item.categories ?? [];
	const first = categories[0];

	return typeof first === 'string' ? first.split('|')[0]?.trim() ?? '' : '';
}

function imageFrom(item: FeedItem): string | undefined {
	if (item.enclosure?.url && (!item.enclosure.type || item.enclosure.type.includes('image'))) {
		return item.enclosure.url;
	}

	const mediaContent = Array.isArray(item.mediaContent) ? item.mediaContent : item.mediaContent ? [item.mediaContent] : [];

	for (const media of mediaContent) {
		const url = media.$?.url;
		const type = media.$?.type;

		if (url && (!type || type.includes('image') || /\.(jpe?g|png|gif|webp)$/i.test(url))) {
			return url;
		}
	}

	return undefined;
}

function stripHtml(value: string): string {
	return load(value).text().replace(/\s+/g, ' ').trim();
}

function imageLookupFromXml(xml: string): Map<string, string> {
	const $ = load(xml, {xmlMode: true});
	const images = new Map<string, string>();

	$('entry, item').each((_, element) => {
		const node = $(element);
		const keys = [
			node.children('id').first().text().trim(),
			node.children('link[rel="alternate"]').first().attr('href') ?? '',
			node.children('link').first().text().trim(),
		].filter(Boolean);
		const image =
			node.children('link[rel="enclosure"][type*="image"]').first().attr('href') ??
			node.children('enclosure[type*="image"]').first().attr('url') ??
			node.children('media\\:content, content').first().attr('url') ??
			'';

		if (!image) {
			return;
		}

		for (const key of keys) {
			images.set(key, image);
		}
	});

	return images;
}

function splitParagraphs(value: string): string[] {
	return value
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
		.filter(Boolean);
}

function jsonLdItems(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		return value;
	}

	if (isRecord(value) && Array.isArray(value['@graph'])) {
		return value['@graph'];
	}

	return [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function formatDate(date: Date): string {
	const time = new Intl.DateTimeFormat('nl-BE', {
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
	const day = new Intl.DateTimeFormat('nl-BE', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
	}).format(date);

	return `${time} · ${day}`;
}
