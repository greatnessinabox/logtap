# LogTap

**Universal console debugging with smart filtering, persistent logs, semantic search, and anomaly detection.**

LogTap transforms your browser's console from a firehose of noise into actionable debugging intelligence.

![Chrome Web Store](https://img.shields.io/badge/Chrome-Extension-green?logo=googlechrome)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Persistent Logs** — Logs survive page reloads via IndexedDB. Never lose a log again.
- **Semantic Search** — Natural language queries like "show auth errors from last hour"
- **Deep Object Snapshots** — See values at log time, not current reference
- **Anomaly Detection** — Learns your app's baseline and flags unusual patterns
- **Timeline Visualization** — Visual density chart with error/warning markers
- **Smart Deduplication** — Collapse repeated messages automatically
- **Export & Import** — Share debugging sessions with teammates
- **Multi-format Export** — Plain text, Markdown, JSON, CSV
- **Anonymization** — Strip sensitive data (emails, IPs, tokens) before sharing

## Installation

### Chrome Web Store (Recommended)
Coming soon.

### Manual Installation (Development)

1. Clone the repository:
   ```bash
   git clone https://github.com/greatnessinabox/logtap.git
   cd logtap
   ```

2. Open Chrome and navigate to `chrome://extensions`

3. Enable **Developer mode** (top right toggle)

4. Click **Load unpacked** and select the cloned directory

5. Open DevTools (F12) and find the **LogTap** panel

## Usage

### Basic Workflow

1. Open DevTools on any page
2. Navigate to the **LogTap** panel
3. Console output is automatically captured and displayed
4. Use filters, search, and timeline to find what you need

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+L` | Toggle capture on/off |
| `Alt+Shift+C` | Clear all logs |
| `Alt+Shift+X` | Copy logs to clipboard |
| `Escape` | Clear search / close panels |

### Search Examples

```
errors                          # All error-level logs
errors from last 5 minutes      # Time-scoped search
auth errors                     # Keyword + level
/userId:\s*\d+/                 # Regex pattern
network requests today          # Natural language
```

### Filtering

- **Level filters** — Toggle info, warn, error, debug visibility
- **Tag filters** — Filter by auto-detected tags like `[API]`, `[Auth]`, etc.
- **Timeline selection** — Click and drag to filter by time range
- **Deduplication** — Collapse repeated messages

## Development

### Project Structure

```
logtap/
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Service worker
├── content.js          # Content script (bridge)
├── injected.js         # Page context script (console interceptor)
├── devtools.html/js    # DevTools page registration
├── panel.html/js/css   # Main UI
└── lib/
    ├── filter-core.js      # Filter engine
    ├── semantic-search.js  # Natural language search
    ├── snapshot-engine.js  # Deep object cloning
    ├── anomaly-detector.js # Pattern learning
    ├── storage-manager.js  # IndexedDB persistence
    ├── export-engine.js    # Multi-format export
    └── ...
```

### Local Development

1. Make changes to source files
2. Go to `chrome://extensions`
3. Click the refresh icon on the LogTap extension
4. Reopen DevTools to see changes

### Testing

Test on various sites to ensure compatibility:
- High-volume logging (Twitter/X, Gmail)
- Framework sites (React, Vue, Angular)
- Your own development projects

## Privacy

LogTap captures **console output only**. Your data never leaves your browser.

- No analytics
- No telemetry
- No external servers
- All data stored locally in IndexedDB

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) © Marquis Nobles
