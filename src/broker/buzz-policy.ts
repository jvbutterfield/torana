import manifest from "../../spike/buzz-transport/cli-manifest.json" with { type: "json" };

export type BuzzPolicyProfile =
  | "read_only"
  | "collaborate"
  | "maintainer"
  | "custom";

interface ManifestSubcommand {
  command: string;
  subcommands?: Array<{ command: string }>;
}

const commandPaths = new Set<string>();
for (const group of manifest.commands) {
  for (const subcommand of group.subcommands as ManifestSubcommand[]) {
    if (subcommand.subcommands?.length) {
      for (const nested of subcommand.subcommands) {
        commandPaths.add(
          `${group.command}.${subcommand.command}.${nested.command}`,
        );
      }
    } else {
      commandPaths.add(`${group.command}.${subcommand.command}`);
    }
  }
}

const READ_ONLY_VERBS = new Set([
  "archived",
  "audit",
  "contacts",
  "event",
  "export",
  "get",
  "hash",
  "inspect",
  "list",
  "ls",
  "members",
  "notes",
  "presence",
  "reports",
  "restricted",
  "runs",
  "search",
  "thread",
  "validate",
]);

const READ_ONLY = new Set(
  [...commandPaths].filter((path) =>
    READ_ONLY_VERBS.has(path.split(".").at(-1) ?? ""),
  ),
);

const COLLABORATE_ADDITIONS = new Set([
  "channels.join",
  "channels.leave",
  "dms.open",
  "issues.create",
  "issues.status",
  "mem.patch",
  "mem.set",
  "messages.delete",
  "messages.edit",
  "messages.send",
  "messages.send-diff",
  "notes.set",
  "patches.send",
  "pr.open",
  "pr.update",
  "reactions.add",
  "reactions.remove",
  "social.publish",
  "social.set-contacts",
  "social.set-list",
  "upload.file",
]);

const MAINTAINER_ADDITIONS = new Set([
  "canvas.set",
  "channels.add-member",
  "channels.archive",
  "channels.create",
  "channels.purpose",
  "channels.remove-member",
  "channels.set-add-policy",
  "channels.topic",
  "channels.unarchive",
  "channels.update",
  "emoji.import",
  "emoji.rm",
  "emoji.set",
  "mem.rm",
  "projects.add-repo",
  "projects.create",
  "projects.remove-repo",
  "projects.update",
  "repos.bind",
  "repos.create",
  "workflows.create",
  "workflows.delete",
  "workflows.trigger",
  "workflows.update",
]);

export const DANGEROUS_BUZZ_COMMANDS = new Set([
  "agents.archive",
  "agents.draft-create",
  "agents.draft-update",
  "agents.unarchive",
  "channels.delete",
  "moderation.ban",
  "moderation.resolve",
  "moderation.timeout",
  "moderation.unban",
  "moderation.untimeout",
  "projects.delete",
  "repos.protect.remove",
  "repos.protect.set",
  "workflows.approve",
]);

/**
 * Options whose capability impact is materially broader than the command's
 * pre-existing use. `channels.update --visibility open` can expose a private
 * channel, so it must not arrive through the general maintainer allowance.
 */
export function assertBuzzOptionPolicy(args: {
  commandPath: string;
  optionNames: Iterable<string>;
  profile: BuzzPolicyProfile;
  acknowledgeDangerous?: boolean;
}): void {
  const optionNames = new Set(args.optionNames);
  if (
    args.commandPath === "channels.update" &&
    optionNames.has("visibility") &&
    (args.profile !== "custom" || !args.acknowledgeDangerous)
  ) {
    throw new Error(
      "Buzz option '--visibility' requires policy: custom and acknowledge_dangerous: true",
    );
  }
}

export function knownBuzzCommands(): string[] {
  return [...commandPaths].sort();
}

export function isKnownBuzzCommand(path: string): boolean {
  return commandPaths.has(path);
}

export function isReadOnlyBuzzCommand(path: string): boolean {
  return READ_ONLY.has(path);
}

export function resolveBuzzPolicy(args: {
  profile: BuzzPolicyProfile;
  allowedCommands?: readonly string[];
  acknowledgeDangerous?: boolean;
}): ReadonlySet<string> {
  if (args.profile === "custom") {
    const allowed = new Set(args.allowedCommands ?? []);
    for (const path of allowed) {
      if (!commandPaths.has(path)) {
        throw new Error(`unknown Buzz command '${path}'`);
      }
      if (DANGEROUS_BUZZ_COMMANDS.has(path) && !args.acknowledgeDangerous) {
        throw new Error(
          `dangerous Buzz command '${path}' requires acknowledge_dangerous: true`,
        );
      }
    }
    return allowed;
  }

  const allowed = new Set(READ_ONLY);
  if (args.profile === "collaborate" || args.profile === "maintainer") {
    for (const path of COLLABORATE_ADDITIONS) allowed.add(path);
  }
  if (args.profile === "maintainer") {
    for (const path of MAINTAINER_ADDITIONS) allowed.add(path);
  }
  return allowed;
}

export function buzzCommandPath(input: {
  group: string;
  command: string;
  nestedCommand?: string;
}): string {
  return [input.group, input.command, input.nestedCommand]
    .filter((part): part is string => Boolean(part))
    .join(".");
}

export const BUZZ_CLI_PIN = Object.freeze({
  applicationVersion: "0.5.9",
  tag: "desktop-v0.5.9",
  commit: "ee33722615ca1e7b8efb03e2ed641d99448c8899",
  sha256: manifest.sha256,
  manifestSchemaVersion: manifest.schemaVersion,
});
