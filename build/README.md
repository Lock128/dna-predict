# Build & packaging

Three ways to build the `epic` binary, depending on where it will run.
Artifacts land in `dist/` (tarball + SHA-256), which is gitignored.

| Goal | Use | Output |
|---|---|---|
| Run locally on this Mac | `build/package-macos.sh` | `dist/epic-<ver>-<apple-target>.tar.gz` |
| Run on AWS Graviton (ARM Linux) | `build/build-graviton.sh` | `dist/epic-<ver>-aarch64-unknown-linux-gnu.tar.gz` |
| Run on AWS as a container | `Dockerfile` (see below) | a Docker image |

All three build the same crate (`rust/`) in `--release`.

## Corporate TLS (Zscaler)

We're behind Zscaler, which intercepts HTTPS and re-signs it with its own root
CA. Without trusting that root, crates.io downloads fail with
`SSL certificate ... unable to get local issuer certificate`.

The fix is baked into all three build paths, using the CA vendored at
[`build/certs/zscaler-root-ca.crt`](./certs/zscaler-root-ca.crt):

- **Dockerfile** — copies the cert into `/usr/local/share/ca-certificates/`,
  runs `update-ca-certificates`, and sets `CARGO_HTTP_CAINFO` before any
  network call.
- **`build-graviton.sh`** — the Docker method mounts + registers the cert inside
  the build container; the native method exports `CARGO_HTTP_CAINFO`.
- **`package-macos.sh`** — exports `CARGO_HTTP_CAINFO` pointing at the cert.

Each is a no-op off-network (the cert just becomes an extra trusted root). To
use a different CA, set `CARGO_HTTP_CAINFO=/path/to/ca.pem` before running, or
replace `build/certs/zscaler-root-ca.crt`.

The vendored cert is a public corporate root CA (not a secret), so it's safe to
commit and keeps builds reproducible for the whole team.

---

## 1. Local macOS

Native release build for this Mac (Apple Silicon → `aarch64-apple-darwin`,
Intel → `x86_64-apple-darwin`), packaged into a tarball.

```bash
build/package-macos.sh
# -> dist/epic-0.1.0-aarch64-apple-darwin.tar.gz (+ .sha256)
```

Run it:

```bash
tar xzf dist/epic-0.1.0-aarch64-apple-darwin.tar.gz
./epic-0.1.0-aarch64-apple-darwin/epic baseline --help
```

---

## 2. AWS Graviton (ARM64 Linux)

Cross-compiles for `aarch64-unknown-linux-gnu` so the binary runs directly on
Graviton EC2 instances (r7g/c7g/g5g/...) — copy it over and run, no runtime
setup.

Two methods, selected via `METHOD` (default `docker`):

```bash
# Default: build inside a linux/arm64 rust container (most reliable on macOS).
# Requires Docker Desktop (buildx + QEMU for cross-arch emulation).
build/build-graviton.sh

# Alternative: native rust cross-target. Fast, but needs a full
# aarch64-linux-gnu cross-linker on PATH + matching cargo config. Prefer docker.
METHOD=native build/build-graviton.sh
```

Deploy to an instance:

```bash
scp dist/epic-0.1.0-aarch64-unknown-linux-gnu.tar.gz ec2-user@<host>:~/
ssh ec2-user@<host> 'tar xzf epic-0.1.0-aarch64-unknown-linux-gnu.tar.gz \
  && ./epic-0.1.0-aarch64-unknown-linux-gnu/epic baseline --help'
```

> Native cross-linking note: the `native` method needs a linux-gnu cross
> toolchain and a cargo linker config, e.g. in `rust/.cargo/config.toml`:
> ```toml
> [target.aarch64-unknown-linux-gnu]
> linker = "aarch64-unknown-linux-gnu-gcc"
> ```
> If you don't have that set up, just use the default Docker method.

---

## 3. Docker image (for AWS ECS/Fargate/Batch or any EC2 with Docker)

Multi-stage build → minimal Debian-slim runtime image with only the binary,
running as a non-root user. Data is not baked in; mount it at `/data` or sync
from S3 at run time (see `../docs/AWS.md`).

Build for Graviton (ARM64):

```bash
docker buildx build --platform linux/arm64 -t epic:latest --load .
```

Build for x86_64:

```bash
docker buildx build --platform linux/amd64 -t epic:latest --load .
```

Run it (mounting local data):

```bash
docker run --rm -v "$PWD/data":/data epic:latest baseline \
  --genome /data/nematostella/genome.fa \
  --plus   /data/nematostella/initiation.plus.bedgraph \
  --minus  /data/nematostella/initiation.minus.bedgraph \
  --test-contigs <held_out_contig> \
  --out /data/submission.tsv
```

Push to Amazon ECR for use on AWS:

```bash
aws ecr create-repository --repository-name epic || true
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)
REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/epic"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker buildx build --platform linux/arm64 -t "$REPO:latest" --push .
```
