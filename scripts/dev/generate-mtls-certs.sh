#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# FGMP mTLS certificate generation (development / demo deployment).
#
# Generates a local CA plus the two certificates the platform needs:
#   - server: presented by the Caddy gateway on the internal mTLS
#              listener (127.0.0.1:8443)
#   - client: presented by the IoT bridge when it ingests telemetry
#
# PRODUCTION: replace these with certificates from your internal CA.
# Never commit the generated keys — ./certs is in .gitignore.
#
# Usage:   scripts/dev/generate-mtls-certs.sh [output-dir]
# Default output dir: ./certs
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

OUT_DIR="${1:-./certs}"
mkdir -p "$OUT_DIR"

DAYS="${MTLS_CERT_DAYS:-365}"

echo "→ Generating deployment CA"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/ca.key" \
  -out "$OUT_DIR/ca.crt" \
  -days "$DAYS" \
  -subj "/CN=FGMP Deployment CA" \
  -addext "basicConstraints=critical,CA:TRUE"

echo "→ Generating server certificate (gateway listener)"
openssl req -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/server.key" \
  -out "$OUT_DIR/server.csr" \
  -subj "/CN=fgmp-gateway"
openssl x509 -req \
  -in "$OUT_DIR/server.csr" \
  -CA "$OUT_DIR/ca.crt" -CAkey "$OUT_DIR/ca.key" -CAcreateserial \
  -out "$OUT_DIR/server.crt" \
  -days "$DAYS" \
  -extfile <(printf "subjectAltName=DNS:localhost,DNS:fgmp-app,IP:127.0.0.1\nextendedKeyUsage=serverAuth")

echo "→ Generating client certificate (IoT bridge)"
openssl req -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/client.key" \
  -out "$OUT_DIR/client.csr" \
  -subj "/CN=fgmp-iot-bridge"
openssl x509 -req \
  -in "$OUT_DIR/client.csr" \
  -CA "$OUT_DIR/ca.crt" -CAkey "$OUT_DIR/ca.key" -CAcreateserial \
  -out "$OUT_DIR/client.crt" \
  -days "$DAYS" \
  -extfile <(printf "subjectAltName=DNS:fgmp-iot-bridge\nextendedKeyUsage=clientAuth")

rm -f "$OUT_DIR/server.csr" "$OUT_DIR/client.csr"

echo "✓ mTLS certificates ready in $OUT_DIR"
echo "  ca.crt ca.key server.crt server.key client.crt client.key"
echo ""
echo "Next: docker compose up -d (the compose file mounts ./certs"
echo "into the gateway and the IoT bridge automatically)."
