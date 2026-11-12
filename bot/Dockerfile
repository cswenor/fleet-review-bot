FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates tini && rm -rf /var/lib/apt/lists/*
# Carry-forward must preserve indentation: https://git-scm.com/docs/git-patch-id/2.39.0
RUN git --version && dpkg --compare-versions "$(git --version | cut -d ' ' -f3)" ge 2.39 \
    && git patch-id --verbatim < /dev/null
# Official standalone glibc Linux x64 asset, not a locally staged binary:
# https://github.com/can1357/oh-my-pi/releases/tag/v18.17.0
# Digest source: https://api.github.com/repos/can1357/oh-my-pi/releases/assets/715993849
ARG OMP_VERSION=18.17.0
ARG OMP_SHA256=a4ce6001ab1012ca835f4184d675437531bd1ac477a7ba8424ed0b5476e9e4cb
RUN node --input-type=module -e 'import { createWriteStream } from "node:fs"; import { pipeline } from "node:stream/promises"; const response = await fetch("https://github.com/can1357/oh-my-pi/releases/download/v" + encodeURIComponent(process.env.OMP_VERSION) + "/omp-linux-x64"); if (!response.ok || !response.body) throw new Error("OMP release download failed: HTTP " + response.status); await pipeline(response.body, createWriteStream("/usr/local/bin/omp", { flags: "wx" }));' \
    && printf '%s  /usr/local/bin/omp\n' "$OMP_SHA256" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/omp
# omp://environment-variables.md: PI_NATIVES_DIR appends the version and reuses
# an existing expected-size addon without extraction. Runtime users cannot modify it.
# The loader extracts only the selected CPU variant; stage both for read-only hosts.
ENV PI_NATIVES_DIR=/opt/omp-natives
RUN --network=none omp --version | grep -qx 'omp/18.17.0' \
    && HOME=/tmp/omp-native-build node --input-type=module -e 'import { spawnSync } from "node:child_process"; for (const variant of ["modern", "baseline"]) { const run = spawnSync("omp", ["--model", "openai-codex/gpt-6.1-sol", "--no-prewalk", "--no-title", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--tools", "read", "--max-time", "1", "--print", "No network native extraction"], { env: { ...process.env, PI_NATIVE_VARIANT: variant }, input: "", encoding: "utf8", timeout: 15000 }); if (run.status !== 1 || !run.stderr.includes("No API key found for openai-codex.")) throw new Error("Native extraction startup did not reach the expected credential gate: " + variant); }' \
    && test -s "/opt/omp-natives/$OMP_VERSION/pi_natives.linux-x64-modern.node" \
    && test -s "/opt/omp-natives/$OMP_VERSION/pi_natives.linux-x64-baseline.node" \
    && chmod -R a-w,a+rX /opt/omp-natives \
    && rm -rf /tmp/omp-native-build
COPY bot/*.mjs /opt/pr-review-bot/bot/
COPY bot/config/ /opt/pr-review-bot/config/
COPY bot/bin/ /opt/pr-review-bot/bin/
COPY scripts/builder/builder.mjs /opt/pr-review-bot/scripts/builder/builder.mjs
COPY scripts/repository-identity.mjs /opt/pr-review-bot/scripts/repository-identity.mjs
COPY scripts/ci-tested-tree.mjs /opt/pr-review-bot/scripts/ci-tested-tree.mjs
RUN chmod -R a+rX /opt/pr-review-bot && chmod a+x /opt/pr-review-bot/bin/*.sh
RUN omp --version | grep -qx 'omp/18.17.0'
RUN useradd --uid 10010 --create-home --home-dir /home/review review
ARG GIT_SHA
ENV IMAGE_REVISION=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
USER 10010:10010
ENTRYPOINT ["/usr/bin/tini","--"]
