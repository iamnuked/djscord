export interface DesktopChannel {
  id: string;
  name: string;
}

export interface DesktopGuild {
  id: string;
  name: string;
  voiceChannels: DesktopChannel[];
  textChannels: DesktopChannel[];
  player: {
    voiceChannelId: string | null;
    title: string;
    author: string;
    playing: boolean;
    paused: boolean;
    volume: number;
    systemAudio: boolean;
    queue: string[];
  } | null;
}

export interface DesktopSnapshot {
  ready: boolean;
  audioReady: boolean;
  botName: string;
  guilds: DesktopGuild[];
}

export interface DesktopCommand {
  guildId: string;
  action: "systemAudio" | "play" | "stop" | "pause" | "resume" | "skip" | "volume";
  voiceChannelId?: string | undefined;
  textChannelId?: string | undefined;
  query?: string | undefined;
  volume?: number | undefined;
}
