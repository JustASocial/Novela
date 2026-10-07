<p align="center"><a href="https://github.com/JustASocial/Novela/releases/latest">
<img src="assets/icon.png" width="180px" />
</a>
</p>


<h1 align="center">Novela</h1>


<p align="center">
<b>Desktop obfuscator for Luau scripts</b><br>
Custom VM · Control-flow flattening · String encryption
</p>

<p align="center">
<img src="https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white" />
<img src="https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white" />
<img src="https://img.shields.io/badge/Luau-00A2FF?logo=lua&logoColor=white" />
</p>

Novela takes a readable Luau script and turns it into something nobody wants to read: flattened control flow, encrypted strings, junk states guarded by opaque predicates, all packed into a compressed virtual-machine loader. Every build looks different.

![Obfuscator](docs/screenshot-obfuscator.png)

## Features

- Custom VM loader (LZ77 + keyed stream cipher + Base85 / Base64 / Hex transport)
- Control-flow flattening with two dispatcher shapes
- String table encryption, identifier renaming, number masking
- Anti-tamper checks, integrity checksum, executor + sUNC report mode
- One-click loadstring via Pastebin / Pastefy
- Built-in HTTP API and optional local server with tray mode
- 12 interface languages, 5 themes, Monaco editing with Luau autocomplete

![Settings](docs/screenshot-settings.png)

## Download

Grab the latest build from the [**Releases**](https://github.com/JustASocial/Novela/releases/latest) page:

- `Novela-Setup-1.2.0.exe` — installer
- `Novela-Portable/` — no install needed, just run `Novela.exe`

## Build from source

Requirements: Node.js 20+, .NET 8 SDK.

```sh
npm install        # pulls Electron and syncs the Monaco runtime
npm run build:core # builds the backend (see note below)
npm start
```

To package everything (installer + portable):

```sh
npm run release
```

> Note: the obfuscation core (`Novela.Core`) ships as a prebuilt, obfuscated binary and its source is not part of this repository. For a local build, drop a `Novela.Core` executable into `core-dist/` (or point `NOVELA_CORE_PATH` at it), or run it as a server — see below.

## HTTP API

```sh
Novela.Core serve --port 4477 --token secret
```

```sh
curl -X POST http://127.0.0.1:4477/api/obfuscate \
  -H "Content-Type: application/json" \
  -d '{"source":"print(1)","seed":7}'
```

`GET /api/health` reports liveness. With a token set, send it as `X-Novela-Token`.

## Loadstrings

Set a Pastebin dev key or a Pastefy API key in Settings, then hit **Loadstring** on any output. Novela uploads it under a random name, copies the raw URL and gives you a ready snippet:

```lua
loadstring(game:HttpGet("https://pastefy.app/xxxx/raw"))()
```

## Settings++

Everything tunable lives under Settings++: ciphers, encodings, VM layers, junk volume and style, dispatcher shape, string splitting, decoys, identifier styles and more.

## License

Source of the interface is provided as-is for personal use. The obfuscation core is proprietary and distributed as a binary only.
