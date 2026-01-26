# Contributing to LogTap

Thanks for your interest in contributing to LogTap!

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Load the extension in Chrome (see README for instructions)
4. Make your changes
5. Test thoroughly
6. Submit a pull request

## Development Guidelines

### Code Style

- Use modern JavaScript (ES2020+)
- Prefer `const` over `let`, avoid `var`
- Use meaningful variable names
- Keep functions focused and small
- No unnecessary comments — code should be self-documenting

### Commit Messages

Use clear, descriptive commit messages:

```
feat: add regex support to semantic search
fix: prevent duplicate logs on rapid navigation
refactor: simplify filter-core state management
docs: update keyboard shortcuts in README
```

Prefixes: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

### Pull Requests

- Keep PRs focused on a single change
- Include a clear description of what and why
- Test on multiple sites before submitting
- Update documentation if needed

## Architecture Notes

### Message Flow

```
Page Context (injected.js)
    ↓ postMessage
Content Script (content.js)
    ↓ chrome.runtime.sendMessage
Background (background.js)
    ↓ port.postMessage
DevTools Panel (panel.js)
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `injected.js` | Intercepts console.* calls in page context |
| `snapshot-engine.js` | Deep clones objects at log time |
| `semantic-search.js` | Parses natural language queries |
| `anomaly-detector.js` | Learns baseline patterns, flags anomalies |
| `storage-manager.js` | IndexedDB persistence layer |

## Reporting Issues

When reporting bugs, include:

- Chrome version
- Steps to reproduce
- Expected vs actual behavior
- Console errors (if any)
- Sample site URL (if reproducible)

## Feature Requests

Open an issue with:

- Clear description of the feature
- Use case / problem it solves
- Any implementation ideas (optional)

## Questions?

Open an issue or reach out at marquis@cleverer.tech
