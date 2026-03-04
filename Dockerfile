# syntax=docker/dockerfile:1

# Playwright image includes Chromium + required system dependencies.
FROM mcr.microsoft.com/playwright:v1.58.0-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install only backend/frontend runtime dependencies for the web app.
COPY web/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy the web service code.
COPY web/ ./

# Ensure output directory exists for CSV exports.
RUN mkdir -p /app/output

EXPOSE 3000

CMD ["node", "server.js"]
