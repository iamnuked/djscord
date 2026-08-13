interface VoiceAccessInput {
  botCanConnect: boolean;
  botCanSpeak: boolean;
  memberChannelId: string | null;
  playerChannelId: string | null;
}

type VoiceAccessResult =
  | { message: string; ok: false }
  | { ok: true; voiceChannelId: string };

interface VoiceMembershipInput {
  memberChannelId: string | null;
  playerChannelId: string | null;
}

export function validateVoiceMembership({
  memberChannelId,
  playerChannelId
}: VoiceMembershipInput): VoiceAccessResult {
  if (memberChannelId === null) {
    return { ok: false, message: "먼저 음성 채널에 들어가주세요." };
  }

  if (playerChannelId !== null && playerChannelId !== memberChannelId) {
    return { ok: false, message: "봇과 같은 음성 채널에서만 사용할 수 있습니다." };
  }

  return { ok: true, voiceChannelId: memberChannelId };
}

export function validateVoiceAccess({
  botCanConnect,
  botCanSpeak,
  memberChannelId,
  playerChannelId
}: VoiceAccessInput): VoiceAccessResult {
  const membership = validateVoiceMembership({ memberChannelId, playerChannelId });
  if (!membership.ok) return membership;

  if (!botCanConnect && !botCanSpeak) {
    return {
      ok: false,
      message: "봇에 음성 채널 연결과 말하기 권한이 필요합니다."
    };
  }
  if (!botCanConnect) {
    return { ok: false, message: "봇에 음성 채널 연결 권한이 필요합니다." };
  }
  if (!botCanSpeak) {
    return { ok: false, message: "봇에 음성 채널 말하기 권한이 필요합니다." };
  }

  return membership;
}
