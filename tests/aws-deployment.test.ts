import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");

function extractService(compose: string, serviceName: string): string {
  const marker = `\n  ${serviceName}:`;
  const start = compose.indexOf(marker);
  if (start === -1) {
    return "";
  }

  const remainder = compose.slice(start + marker.length);
  const nextService = remainder.search(/\n  [a-zA-Z0-9_-]+:/u);
  return nextService === -1 ? remainder : remainder.slice(0, nextService);
}

describe("AWS production Compose", () => {
  it("uses immutable bot/engine images, private audio services, health checks and host data paths", () => {
    const compose = readFileSync(join(projectRoot, "compose.prod.yaml"), "utf8");

    expect(compose).toContain("image: ${BOT_IMAGE:?");
    expect(compose).toContain("image: ${DJENGINE_IMAGE:?");
    expect(compose).toContain("/opt/djengine/music");
    expect(compose).toContain("/opt/djengine/config/rekordbox.xml");
    expect(compose).toMatch(/"node", "dist\/healthcheck\.js"/);
    expect(compose).toContain("${DATA_DIR:-/opt/djscord/data}");
    expect(compose).toContain("mem_limit:");
    expect(compose).toContain("cpus:");
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).not.toContain("build:");
    const botService = extractService(compose, "bot");
    expect(botService).toContain("DJENGINE_API_KEY: ${DJENGINE_API_KEY:?");
    expect(botService).toContain("DJENGINE_BASE_URL: http://engine:8787");
    expect(botService).toMatch(/networks:\n\s+- default\n\s+- djengine-private/u);

    const engineService = extractService(compose, "engine");
    expect(engineService).toMatch(/networks:\n\s+- djengine-private/u);
    expect(engineService).not.toMatch(/networks:[\s\S]*\n\s+- default/u);

    const lavalinkService = extractService(compose, "lavalink");
    expect(lavalinkService).not.toContain("env_file:");
    expect(lavalinkService).toContain("LAVALINK_PASSWORD:");
    expect(lavalinkService).toMatch(/networks:\n\s+- default\n\s+- djengine-private/u);
    expect(compose).toMatch(/\nnetworks:\n\s+djengine-private:\n\s+internal: true/u);
  });
});

describe("DJ Engine data directory permissions", () => {
  it("matches the engine container runtime UID:GID on deploy and host bootstrap", () => {
    const deployScript = readFileSync(join(projectRoot, "deploy/deploy.sh"), "utf8");
    const template = readFileSync(join(projectRoot, "infra/aws/djscord-ec2.yaml"), "utf8");

    expect(deployScript).toContain(
      'install -d -m 0750 -o 10001 -g 10001 "$engine_data_dir"'
    );
    expect(template).toContain(
      "install -d -m 0750 -o 10001 -g 10001 /opt/djengine/data"
    );
  });

  it("checks music and XML access as the engine runtime UID before replacing containers", () => {
    const deployScript = readFileSync(join(projectRoot, "deploy/deploy.sh"), "utf8");

    expect(deployScript).toContain("setpriv --reuid 10001 --regid 10001 --clear-groups");
    expect(deployScript).toContain('assert_engine_inputs_readable "$music_root" "$rekordbox_xml"');
  });
});

describe("EC2 environment renderer", () => {
  it("writes required and optional Parameter Store values without printing secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "djscord-deploy-"));
    const binDirectory = join(directory, "bin");
    const outputPath = join(directory, ".env");
    mkdirSync(binDirectory);
    const fakeAws = join(binDirectory, "aws");
    writeFileSync(
      fakeAws,
      `#!/bin/sh
name=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--name" ]; then name="$2"; break; fi
  shift
done
case "$name" in
  */DISCORD_TOKEN) printf '%s' "discord's-secret" ;;
  */DISCORD_CLIENT_ID) printf '%s' '123456789012345678' ;;
  */LAVALINK_PASSWORD) printf '%s' 'lavalink-secret-value' ;;
  */DJENGINE_API_KEY) printf '%s' 'djengine-secret-value-32-bytes!!$oops' ;;
  */MIX_INGEST_URL) printf '%s' 'https://mix.example/api/internal/v1' ;;
  */MIX_INGEST_SECRET) printf '%s' 'mix-ingest-secret-value' ;;
  */MIX_PUBLIC_URL) printf '%s' 'https://mix.example/mix' ;;
  */KOFI_URL) printf '%s' 'https://ko-fi.com/example' ;;
  */LASTFM_API_KEY) printf '%s' 'lastfm-secret' ;;
  *) exit 44 ;;
esac
`
    );
    chmodSync(fakeAws, 0o755);

    try {
      const result = spawnSync(
        "sh",
        [
          join(projectRoot, "deploy/render-env.sh"),
          "123.dkr.ecr.ap-northeast-2.amazonaws.com/djscord/bot:abc123",
          "123.dkr.ecr.ap-northeast-2.amazonaws.com/djscord/engine:def456",
          outputPath
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            AWS_REGION: "ap-northeast-2",
            PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
            SSM_PARAMETER_PATH: "/djscord/prod"
          }
        }
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("discord's-secret");
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(outputPath, "utf8")).toBe(
        [
          "BOT_IMAGE='123.dkr.ecr.ap-northeast-2.amazonaws.com/djscord/bot:abc123'",
          "DJENGINE_IMAGE='123.dkr.ecr.ap-northeast-2.amazonaws.com/djscord/engine:def456'",
          "AWS_REGION='ap-northeast-2'",
          "DATA_DIR='/opt/djscord/data'",
          "DATABASE_PATH='/data/djscord.sqlite'",
          "DISCORD_TOKEN='discord\\'s-secret'",
          "DISCORD_CLIENT_ID='123456789012345678'",
          "KOFI_URL='https://ko-fi.com/example'",
          "LASTFM_API_KEY='lastfm-secret'",
          "LAVALINK_HOST='lavalink'",
          "LAVALINK_PORT='2333'",
          "LAVALINK_PASSWORD='lavalink-secret-value'",
          "DJENGINE_API_KEY='djengine-secret-value-32-bytes!!$oops'",
          "DJENGINE_BASE_URL='http://engine:8787'",
          "DJENGINE_DATA_DIR='/opt/djengine/data'",
          "DJENGINE_HOST_MUSIC_ROOT='/opt/djengine/music'",
          "DJENGINE_HOST_REKORDBOX_XML='/opt/djengine/config/rekordbox.xml'",
          "MIX_INGEST_URL='https://mix.example/api/internal/v1'",
          "MIX_INGEST_SECRET='mix-ingest-secret-value'",
          "MIX_PUBLIC_URL='https://mix.example/mix'",
          ""
        ].join("\n")
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not leave a partial environment file when a required parameter is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "djscord-deploy-"));
    const binDirectory = join(directory, "bin");
    const outputPath = join(directory, ".env");
    mkdirSync(binDirectory);
    const fakeAws = join(binDirectory, "aws");
    writeFileSync(fakeAws, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeAws, 0o755);

    try {
      const result = spawnSync(
        "sh",
        [
          join(projectRoot, "deploy/render-env.sh"),
          "example.invalid/bot:abc123",
          "example.invalid/engine:def456",
          outputPath
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDirectory}:${process.env.PATH ?? ""}`
          }
        }
      );

      expect(result.status).not.toBe(0);
      expect(() => statSync(outputPath)).toThrow();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("omits the optional Mix publisher group when all three parameters are absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "djscord-deploy-"));
    const binDirectory = join(directory, "bin");
    const outputPath = join(directory, ".env");
    mkdirSync(binDirectory);
    const fakeAws = join(binDirectory, "aws");
    writeFileSync(
      fakeAws,
      `#!/bin/sh
name=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--name" ]; then name="$2"; break; fi
  shift
done
case "$name" in
  */DISCORD_TOKEN) printf '%s' 'discord-secret' ;;
  */DISCORD_CLIENT_ID) printf '%s' '123456789012345678' ;;
  */LAVALINK_PASSWORD) printf '%s' 'lavalink-secret-value' ;;
  */DJENGINE_API_KEY) printf '%s' 'djengine-secret-value-32-bytes!!' ;;
  *) exit 44 ;;
esac
`
    );
    chmodSync(fakeAws, 0o755);

    try {
      const result = spawnSync(
        "sh",
        [
          join(projectRoot, "deploy/render-env.sh"),
          "example.invalid/bot:abc123",
          "example.invalid/engine:def456",
          outputPath
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH ?? ""}` }
        }
      );

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputPath, "utf8")).not.toContain("MIX_");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a partially configured Mix publisher group atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "djscord-deploy-"));
    const binDirectory = join(directory, "bin");
    const outputPath = join(directory, ".env");
    mkdirSync(binDirectory);
    const fakeAws = join(binDirectory, "aws");
    writeFileSync(
      fakeAws,
      `#!/bin/sh
name=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--name" ]; then name="$2"; break; fi
  shift
done
case "$name" in
  */DISCORD_TOKEN) printf '%s' 'discord-secret' ;;
  */DISCORD_CLIENT_ID) printf '%s' '123456789012345678' ;;
  */LAVALINK_PASSWORD) printf '%s' 'lavalink-secret-value' ;;
  */DJENGINE_API_KEY) printf '%s' 'djengine-secret-value-32-bytes!!' ;;
  */MIX_INGEST_URL) printf '%s' 'https://mix.example/api/internal/v1' ;;
  *) exit 44 ;;
esac
`
    );
    chmodSync(fakeAws, 0o755);

    try {
      const result = spawnSync(
        "sh",
        [
          join(projectRoot, "deploy/render-env.sh"),
          "example.invalid/bot:abc123",
          "example.invalid/engine:def456",
          outputPath
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH ?? ""}` }
        }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("MIX_INGEST_URL, MIX_INGEST_SECRET, MIX_PUBLIC_URL");
      expect(() => statSync(outputPath)).toThrow();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("EC2 secret publisher", () => {
  it("allows all Mix publisher values to be absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "djscord-secrets-"));
    const envPath = join(directory, ".env");
    const fakeAws = join(directory, "aws");
    const callsPath = join(directory, "aws-calls.log");
    writeFileSync(
      envPath,
      [
        "DISCORD_TOKEN=discord-secret",
        "DISCORD_CLIENT_ID=123456789012345678",
        "LAVALINK_PASSWORD=lavalink-secret-value",
        "DJENGINE_API_KEY=djengine-secret-value-32-bytes!!",
        ""
      ].join("\n")
    );
    writeFileSync(fakeAws, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$AWS_CALL_LOG\"\nexit 0\n");
    chmodSync(fakeAws, 0o755);

    try {
      const result = spawnSync("sh", [join(projectRoot, "deploy/push-secrets.sh"), envPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          AWS_CALL_LOG: callsPath,
          PATH: `${directory}:${process.env.PATH ?? ""}`
        }
      });

      expect(result.status, result.stderr).toBe(0);
      const awsCalls = readFileSync(callsPath, "utf8");
      expect(awsCalls).toContain("ssm delete-parameters");
      expect(awsCalls).toContain("/djscord/prod/MIX_INGEST_URL");
      expect(awsCalls).toContain("/djscord/prod/MIX_INGEST_SECRET");
      expect(awsCalls).toContain("/djscord/prod/MIX_PUBLIC_URL");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a partial Mix publisher group before publishing", () => {
    const directory = mkdtempSync(join(tmpdir(), "djscord-secrets-"));
    const envPath = join(directory, ".env");
    const fakeAws = join(directory, "aws");
    writeFileSync(
      envPath,
      [
        "DISCORD_TOKEN=discord-secret",
        "DISCORD_CLIENT_ID=123456789012345678",
        "LAVALINK_PASSWORD=lavalink-secret-value",
        "DJENGINE_API_KEY=djengine-secret-value-32-bytes!!",
        "MIX_INGEST_URL=https://mix.example/api/internal/v1",
        ""
      ].join("\n")
    );
    writeFileSync(fakeAws, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeAws, 0o755);

    try {
      const result = spawnSync("sh", [join(projectRoot, "deploy/push-secrets.sh"), envPath], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` }
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("MIX_INGEST_URL, MIX_INGEST_SECRET, MIX_PUBLIC_URL");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("DJ Engine release lifecycle", () => {
  it("migrates the legacy single-image deployment record into a rollback pair", () => {
    const deployScript = readFileSync(join(projectRoot, "deploy/deploy.sh"), "utf8");

    expect(deployScript).toContain('legacy_deployed_image_file="$app_dir/.deployed-image"');
    expect(deployScript).toContain('legacy_bot_image=$(sed -n \'1p\' "$legacy_deployed_image_file")');
    expect(deployScript).toContain(
      'printf \'%s\\n%s\\n\' "$legacy_bot_image" "$engine_image" > "$previous_image_file"'
    );
  });

  it("runs the sibling engine rust-test image before publishing the runtime image", () => {
    const publishScript = readFileSync(join(projectRoot, "deploy/publish-release.sh"), "utf8");
    const rustTestTarget = publishScript.indexOf("--target rust-test");
    const runtimeTarget = publishScript.indexOf("--target runtime");

    expect(rustTestTarget).toBeGreaterThan(-1);
    expect(publishScript).toMatch(/docker run --rm [^\n]*engine_test_image/u);
    expect(rustTestTarget).toBeLessThan(runtimeTarget);
  });

  it("refuses to archive uncommitted source while keeping the local Rekordbox XML out of releases", () => {
    const publishScript = readFileSync(join(projectRoot, "deploy/publish-release.sh"), "utf8");

    expect(publishScript).toContain("git status --porcelain --untracked-files=all");
    expect(publishScript).toContain("sed '/^?? rekordbox\\.xml$/d'");
    expect(publishScript).toContain("git archive HEAD");
  });

  it("documents import status and playable playlist verification after media placement", () => {
    const guide = readFileSync(join(projectRoot, "docs/aws-deployment.md"), "utf8");

    expect(guide).toContain("/api/v1/libraries/default/imports");
    expect(guide).toContain("/api/v1/imports/$IMPORT_JOB_ID");
    expect(guide).toContain("analyzedTracks");
    expect(guide).toContain("/api/v1/playlists?limit=100");
    expect(guide).toContain("/mix?guild=...");
    expect(guide).toContain("docker stats --no-stream");
    expect(guide).toContain("audio underrun");
    expect(guide).not.toContain("./deploy/remote-deploy.sh 12자리커밋해시\n");
  });
});

describe("AWS infrastructure template", () => {
  it("provisions a no-ingress EC2 host with retained encrypted storage", () => {
    const template = readFileSync(
      join(projectRoot, "infra/aws/djscord-ec2.yaml"),
      "utf8"
    );

    expect(template).toContain("AmazonSSMManagedInstanceCore");
    expect(template).toContain("AmazonEC2ContainerRegistryReadOnly");
    expect(template).toContain("EngineRepository:");
    expect(template).toContain("/djscord/prod/engine");
    expect(template).toContain("CloudWatchAgentServerPolicy");
    expect(template).toContain("SecurityGroupEgress:");
    expect(template).not.toContain("SecurityGroupIngress:");
    expect(template).toContain("Encrypted: true");
    expect(template).toContain("DeleteOnTermination: false");
    expect(template).toContain("HttpTokens: required");
    expect(template).toContain("dnf install -y docker curl util-linux");
  });
});
