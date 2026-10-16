/** specs-two V17 M-of-N approval gate for CRITICAL tool operations. */
export class ConsensusGate {
  private _state: 'staged' | 'approved' | 'cancelled' = 'staged';
  private readonly approved = new Set<string>();
  private readonly quorum: number;
  private readonly minPower: number;
  private readonly requester: string;

  constructor(opts: { quorum: number; minPower: number; requester: string }) {
    this.quorum = opts.quorum;
    this.minPower = opts.minPower;
    this.requester = opts.requester;
  }

  get state() {
    return this._state;
  }

  get approvers() {
    return [...this.approved];
  }

  approve(userId: string, power: number) {
    if (this._state !== 'staged' || userId === this.requester || power < this.minPower) return;
    this.approved.add(userId);
    if (this.approved.size >= this.quorum) this._state = 'approved';
  }

  reject(_userId: string, power: number) {
    if (this._state !== 'staged' || power < this.minPower) return;
    this._state = 'cancelled';
  }
}
