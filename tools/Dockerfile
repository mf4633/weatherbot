# Book poller — reads public Kalshi market data, writes JSONL. No credentials, no trading.
FROM node:22-alpine

WORKDIR /app
COPY book_poller.js ./

# Ticks land on a mounted volume so a restart or redeploy doesn't lose the series.
ENV OUT_DIR=/data/ticks
ENV INTERVAL_MS=60000

# Non-root: this process only needs to read a public API and append to /data.
RUN addgroup -S poller && adduser -S poller -G poller \
    && mkdir -p /data/ticks && chown -R poller:poller /data
USER poller

CMD ["node", "book_poller.js"]
