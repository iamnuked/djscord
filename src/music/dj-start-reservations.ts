export interface DjStartReservation<TPlayer> {
  cancelled: boolean;
  readonly guildId: string;
  player?: TPlayer;
  readonly requesterId: string;
}

export class DjStartReservations<TPlayer> {
  readonly #reservations = new Map<string, DjStartReservation<TPlayer>>();

  reserve(guildId: string, requesterId: string): DjStartReservation<TPlayer> {
    if (this.#reservations.has(guildId)) {
      throw new Error("이미 DJ 믹스를 시작하고 있습니다.");
    }
    const reservation: DjStartReservation<TPlayer> = {
      cancelled: false,
      guildId,
      requesterId
    };
    this.#reservations.set(guildId, reservation);
    return reservation;
  }

  get(guildId: string): DjStartReservation<TPlayer> | undefined {
    return this.#reservations.get(guildId);
  }

  has(guildId: string): boolean {
    return this.#reservations.has(guildId);
  }

  attachPlayer(reservation: DjStartReservation<TPlayer>, player: TPlayer): boolean {
    if (
      reservation.cancelled ||
      this.#reservations.get(reservation.guildId) !== reservation
    ) {
      return false;
    }
    reservation.player = player;
    return true;
  }

  cancel(guildId: string): DjStartReservation<TPlayer> | undefined {
    const reservation = this.#reservations.get(guildId);
    if (reservation !== undefined) reservation.cancelled = true;
    return reservation;
  }

  release(reservation: DjStartReservation<TPlayer>): void {
    if (this.#reservations.get(reservation.guildId) === reservation) {
      this.#reservations.delete(reservation.guildId);
    }
  }

  values(): DjStartReservation<TPlayer>[] {
    return [...this.#reservations.values()];
  }
}
