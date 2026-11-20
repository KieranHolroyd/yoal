# S4 design-B "control-plane issuer": lego (pinned) beside Bun, which runs cp.ts.
FROM goacme/lego:v5.6.0 AS lego
FROM oven/bun:1.4.4
COPY --from=lego /lego /usr/local/bin/lego
