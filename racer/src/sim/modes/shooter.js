// Shooter mode — under construction (see modes/index.js for the interface).

export class ShooterMode {
  constructor(spec) {
    this.spec = spec;
  }

  build() {
    throw new Error('shooter mode not implemented yet');
  }

  decide() { return null; }
  stepAvatar() {}
  postStep() {}
  respawnPose() { return { x: 0, y: 0, heading: 0 }; }
  placer() {
    return { spawnMonster: () => ({ lairX: 0, lairY: 0 }), spawnPickup: () => ({ x: 0, y: 0 }) };
  }
  snapshot() {}
}
