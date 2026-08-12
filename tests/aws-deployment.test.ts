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

describe("AWS production Compose", () => {
  it("uses an immutable bot image, private Lavalink, health checks and a host data path", () => {
    const compose = readFileSync(join(projectRoot, "compose.prod.yaml"), "utf8");

    expect(compose).toContain("image: ${BOT_IMAGE:?");
    expect(compose).toMatch(/"node", "dist\/healthcheck\.js"/);
    expect(compose).toContain("${DATA_DIR:-/opt/djscord/data}");
    expect(compose).toContain("mem_limit:");
    expect(compose).toContain("cpus:");
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).not.toContain("build:");
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
  */DISCORD_TOKEN) printf '%s' 'discord-secret' ;;
  */DISCORD_CLIENT_ID) printf '%s' '123456789012345678' ;;
  */LAVALINK_PASSWORD) printf '%s' 'lavalink-secret-value' ;;
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
        [join(projectRoot, "deploy/render-env.sh"), "123.dkr.ecr.ap-northeast-2.amazonaws.com/djscord/bot:abc123", outputPath],
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
      expect(result.stdout).not.toContain("discord-secret");
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(outputPath, "utf8")).toBe(
        [
          "BOT_IMAGE=123.dkr.ecr.ap-northeast-2.amazonaws.com/djscord/bot:abc123",
          "AWS_REGION=ap-northeast-2",
          "DATA_DIR=/opt/djscord/data",
          "DATABASE_PATH=/data/djscord.sqlite",
          "DISCORD_TOKEN=discord-secret",
          "DISCORD_CLIENT_ID=123456789012345678",
          "KOFI_URL=https://ko-fi.com/example",
          "LASTFM_API_KEY=lastfm-secret",
          "LAVALINK_HOST=lavalink",
          "LAVALINK_PORT=2333",
          "LAVALINK_PASSWORD=lavalink-secret-value",
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
        [join(projectRoot, "deploy/render-env.sh"), "example.invalid/bot:abc123", outputPath],
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
});

describe("AWS infrastructure template", () => {
  it("provisions a no-ingress EC2 host with retained encrypted storage", () => {
    const template = readFileSync(
      join(projectRoot, "infra/aws/djscord-ec2.yaml"),
      "utf8"
    );

    expect(template).toContain("AmazonSSMManagedInstanceCore");
    expect(template).toContain("AmazonEC2ContainerRegistryReadOnly");
    expect(template).toContain("CloudWatchAgentServerPolicy");
    expect(template).toContain("SecurityGroupEgress:");
    expect(template).not.toContain("SecurityGroupIngress:");
    expect(template).toContain("Encrypted: true");
    expect(template).toContain("DeleteOnTermination: false");
    expect(template).toContain("HttpTokens: required");
  });
});
