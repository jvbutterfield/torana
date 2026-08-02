import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Provenance = {
  releaseArtifact: {
    downloadUrl: string;
    name: string;
    sha256: string;
  };
  buzzExecutable: {
    installedPath: string;
    releaseArchivePath: string;
    sha256: string;
  };
};

function sha256(bytes: ArrayBuffer): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

const provenance = (await Bun.file(
  new URL("artifact-provenance.json", import.meta.url),
).json()) as Provenance;
const workdir = await mkdtemp(join(tmpdir(), "buzz-provenance-"));

try {
  const response = await fetch(provenance.releaseArtifact.downloadUrl);
  if (!response.ok) {
    throw new Error(
      `release download failed: ${response.status} ${response.statusText}`,
    );
  }

  const archiveBytes = await response.arrayBuffer();
  const archiveSha256 = sha256(archiveBytes);
  if (archiveSha256 !== provenance.releaseArtifact.sha256) {
    throw new Error(
      `archive SHA-256 mismatch: expected ${provenance.releaseArtifact.sha256}, got ${archiveSha256}`,
    );
  }

  const archivePath = join(workdir, provenance.releaseArtifact.name);
  await Bun.write(archivePath, archiveBytes);
  const extract = Bun.spawn(["tar", "-xzf", archivePath, "-C", workdir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await extract.exited) !== 0)
    throw new Error("archive extraction failed");

  const releaseCliPath = join(
    workdir,
    provenance.buzzExecutable.releaseArchivePath,
  );
  const releaseCliSha256 = sha256(await Bun.file(releaseCliPath).arrayBuffer());
  if (releaseCliSha256 !== provenance.buzzExecutable.sha256) {
    throw new Error(
      `release CLI SHA-256 mismatch: expected ${provenance.buzzExecutable.sha256}, got ${releaseCliSha256}`,
    );
  }

  const installedCli = Bun.file(provenance.buzzExecutable.installedPath);
  if (await installedCli.exists()) {
    const installedSha256 = sha256(await installedCli.arrayBuffer());
    if (installedSha256 !== releaseCliSha256) {
      throw new Error(
        `installed CLI SHA-256 mismatch: expected ${releaseCliSha256}, got ${installedSha256}`,
      );
    }
  }

  console.log(
    JSON.stringify({
      archiveSha256,
      releaseCliSha256,
      installedCliCompared: await installedCli.exists(),
    }),
  );
} finally {
  await rm(workdir, { recursive: true, force: true });
}
