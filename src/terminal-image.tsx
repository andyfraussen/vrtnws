import React, {useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import sharp from 'sharp';
import {COLORS, HEADERS} from './constants.js';

type Cell = {
	foreground: string;
	background: string;
};

type TerminalImageProps = {
	url: string;
	maxColumns: number;
	maxRows: number;
};

export function TerminalImage({url, maxColumns, maxRows}: TerminalImageProps) {
	const [rows, setRows] = useState<Cell[][] | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let active = true;

		async function loadImage() {
			try {
				const response = await fetch(url, {headers: HEADERS});

				if (!response.ok) {
					throw new Error(`Image returned ${response.status}`);
				}

				const source = Buffer.from(await response.arrayBuffer());
				const metadata = await sharp(source).metadata();

				if (!metadata.width || !metadata.height) {
					throw new Error('Image dimensions unavailable');
				}

				const scale = Math.min(maxColumns / metadata.width, (maxRows * 2) / metadata.height, 1);
				const width = Math.max(1, Math.floor(metadata.width * scale));
				let height = Math.max(2, Math.floor(metadata.height * scale));

				if (height % 2 === 1) {
					height += 1;
				}

				const {data} = await sharp(source)
					.rotate()
					.resize(width, height, {fit: 'fill'})
					.removeAlpha()
					.raw()
					.toBuffer({resolveWithObject: true});

				const nextRows: Cell[][] = [];

				for (let y = 0; y < height; y += 2) {
					const line: Cell[] = [];

					for (let x = 0; x < width; x += 1) {
						line.push({
							foreground: pixelToHex(data, width, x, y),
							background: pixelToHex(data, width, x, Math.min(y + 1, height - 1)),
						});
					}

					nextRows.push(line);
				}

				if (active) {
					setRows(nextRows);
				}
			} catch {
				if (active) {
					setFailed(true);
				}
			}
		}

		void loadImage();

		return () => {
			active = false;
		};
	}, [maxColumns, maxRows, url]);

	if (failed) {
		return null;
	}

	if (!rows) {
		return <Text color={COLORS.muted}>Afbeelding laden...</Text>;
	}

	return (
		<Box flexDirection="column" marginY={1}>
			{rows.map((row, rowIndex) => (
				<Text key={rowIndex}>
					{row.map((cell, cellIndex) => (
						<Text key={cellIndex} color={cell.foreground} backgroundColor={cell.background}>
							▀
						</Text>
					))}
				</Text>
			))}
		</Box>
	);
}

function pixelToHex(data: Buffer, width: number, x: number, y: number): string {
	const offset = (y * width + x) * 3;

	return `#${toHex(data[offset] ?? 0)}${toHex(data[offset + 1] ?? 0)}${toHex(data[offset + 2] ?? 0)}`;
}

function toHex(value: number): string {
	return value.toString(16).padStart(2, '0');
}
