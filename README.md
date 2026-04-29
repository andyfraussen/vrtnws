# vrtnws

VRT NWS terminal reader. Browse the latest news and sports from [vrtnws.be](https://www.vrt.be/vrtnws/nl/) and [sporza.be](https://sporza.be) without leaving your terminal.

![screenshot](screenshot.png)

## Install

```bash
npm install --global vrtnws
```

## Usage

```bash
vrtnws
```

## Development

```bash
npm install
npm run dev
```

Build the CLI.

```bash
npm run build
```

Run local checks.

```bash
npm run typecheck
npm pack --dry-run
```

Test the command from this checkout.

```bash
npm link
vrtnws
```

Remove the linked command when you are done testing.

```bash
npm unlink --global vrtnws
```

## Publishing

The package is published as `vrtnws` on npm.

1. Log in to npm.

```bash
npm login
```

2. Check the package contents.

```bash
npm run typecheck
npm pack --dry-run
```

3. Publish a new version.

```bash
npm publish --access public
```

4. Install the published package.

```bash
npm install --global vrtnws
vrtnws
```

## Keys

1. `↑` / `↓`: Navigate articles
2. `j` / `k`: Navigate articles or scroll article text
3. `Enter` / `o`: Open article
4. `ESC` / `b`: Back to list
5. `o`: Open full article in browser from the article detail
6. `Tab`: Switch between Nieuws and Sport
7. `r`: Refresh the current feed
8. `h`: Help
9. `q`: Quit

## Sections

Nieuws (VRT NWS), Sport (Sporza).

Feeds refresh automatically every 5 minutes.

## Requirements

Node.js 22 or newer.
