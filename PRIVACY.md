# Privacy Policy for LogTap Console Formatter

**Last Updated:** January 25, 2026

## Overview

LogTap Console Formatter is a browser extension that helps developers debug web applications by capturing and organizing console output. This privacy policy explains what data LogTap accesses, how it's used, and your rights.

## Data Collection

### What LogTap Captures

LogTap captures **console output only** from web pages you visit. This includes:

- Messages logged via `console.log()`, `console.warn()`, `console.error()`, `console.debug()`, and `console.trace()`
- Stack traces associated with console calls
- Timestamps of when logs occurred

### What LogTap Does NOT Capture

LogTap does **not** collect, access, or transmit:

- Page content (HTML, text, images)
- Form data or user inputs
- Passwords or authentication credentials
- Network requests or responses
- Cookies or session data
- Browsing history
- Personal information

## Data Storage

### Local Storage Only

All captured log data is stored **locally on your device** using:

- **IndexedDB**: For persistent log storage across browser sessions
- **Chrome Storage API**: For user preferences and settings

**Your data never leaves your browser.** LogTap has no servers, no analytics, and no external data transmission.

### Data Retention

- Logs are automatically deleted after **7 days**
- Maximum of **50,000 logs** are retained (oldest are removed first)
- You can manually clear all data at any time using the "Clear" button

## Permissions Explained

### "Read and change all your data on all websites"

This permission (`<all_urls>`) is required to:

- Inject the console interceptor script on any website you choose to debug
- Capture console output from the page context

**LogTap only reads console output.** It does not read or modify any other page content.

### "Storage"

Used to:

- Store captured logs in IndexedDB
- Save your preferences (theme, filter settings)

### "Clipboard Write"

Used to:

- Copy formatted logs to your clipboard when you click "Copy"

## Data Sharing

LogTap **does not share any data** with third parties. Period.

- No analytics services
- No crash reporting
- No telemetry
- No advertising

## Export Feature

LogTap includes an export feature that saves logs to a `.logtap` file on your computer. This feature:

- Is entirely user-initiated
- Saves data only to your local file system
- Includes an optional **anonymization** feature that strips:
  - Email addresses
  - IP addresses
  - URLs
  - JWT tokens
  - API keys
  - Credit card numbers
  - Social Security Numbers

## Your Rights

You have complete control over your data:

1. **Access**: View all captured logs in the DevTools panel
2. **Delete**: Clear all logs instantly with the "Clear" button
3. **Export**: Download your logs at any time
4. **Disable**: Toggle capture off or uninstall the extension

## Open Source

LogTap is open source. You can review the complete source code to verify these privacy practices:

https://github.com/greatnessinabox/logtap

## Children's Privacy

LogTap is a developer tool not directed at children under 13. We do not knowingly collect data from children.

## Changes to This Policy

If we update this privacy policy, we will:

- Update the "Last Updated" date above
- Include a summary of changes in the extension's changelog

## Contact

For privacy questions or concerns:

- **GitHub Issues**: https://github.com/greatnessinabox/logtap/issues
- **Email**: marquis@cleverer.tech

---

## Summary

| Question | Answer |
|----------|--------|
| Does LogTap collect personal data? | No |
| Does LogTap send data to servers? | No |
| Where is data stored? | Locally on your device only |
| Can I delete my data? | Yes, instantly via "Clear" button |
| Is LogTap open source? | Yes |
