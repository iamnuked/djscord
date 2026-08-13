export type DjInteraction =
  | { commandName: string; kind: "command" }
  | { action: string; kind: "component" };

export function isDjInteractionAllowed(interaction: DjInteraction): boolean {
  return (
    interaction.kind === "command" &&
    (interaction.commandName === "디제이" || interaction.commandName === "볼륨")
  );
}
