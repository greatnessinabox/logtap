# Security Policy

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in LogTap, please report it responsibly.

### How to Report

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting:
https://github.com/greatnessinabox/logtap/security/advisories/new

Or email: **marquis@cleverer.tech**

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

### What to Expect

- **Acknowledgment**: We'll acknowledge receipt within 48 hours
- **Assessment**: We'll assess the vulnerability and determine its severity
- **Resolution**: We'll work on a fix and coordinate disclosure
- **Credit**: We'll credit you in the release notes (unless you prefer anonymity)

### Scope

This security policy applies to:

- The LogTap Chrome extension
- This GitHub repository

### Out of Scope

- Logs captured by the extension (that's your data)
- Third-party websites you debug
- Chrome browser vulnerabilities (report to Google)

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 3.x     | :white_check_mark: |
| < 3.0   | :x:                |

## Security Model

LogTap is designed with privacy in mind:

- **Local-only storage**: All data stays in your browser (IndexedDB)
- **No external connections**: Zero network requests, no analytics, no telemetry
- **Minimal permissions**: Only what's needed for console interception
- **Open source**: Full source code available for audit

### Permission Justification

| Permission | Why It's Needed |
|------------|-----------------|
| `<all_urls>` | Inject console interceptor on any debugged site |
| `storage` | Save logs and preferences locally |
| `clipboardWrite` | Copy logs to clipboard |
| `contextMenus` | Right-click menu options |

Thank you for helping keep LogTap and its users safe!
