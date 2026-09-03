# Caddy с модулем DuckDNS: сертификат Let's Encrypt выпускается через DNS-запись,
# поэтому наружу достаточно порта 443 (80 — только для перенаправления на https).
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
