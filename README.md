# LocalKeys

## https://localkeys.privatestater.com

# CLI

```bash
# Check project list
localkeys list

# Save your secret
localkeys set myapp API_KEY "sk-1234567890abcdef"

# Secret lookup
localkeys get myapp API_KEY

# Executing commands with environment variables
localkeys run --project=myapp -- npm start
```

# Build

## Build for all platforms

```bash
npm run build -- --mac && npm run build -- --win
```

## Build for specific platform

```bash
npm run build -- --mac
```
```bash
npm run build -- --win
```
```bash
npm run build -- --linux
```