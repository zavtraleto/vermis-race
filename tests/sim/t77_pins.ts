// Recorded 2026-11-21 on feat/rivals at 9303337 (before T77: R84c, R85e, R85f not in code) with
// tests/sim/t77_helpers.ts traceHash. Hash of every tick's pre-T77 car fields : final x.
// PIN_LEGACY: free(P0) + gripLead 0, gripDodge 0, NO_T77. PIN_STRAIGHT: free(P0) as is.
// PIN_HELD: free(P0) + driftRail 0. Do not regenerate: these are the old behaviour.
export const PIN_LEGACY: Record<string, string> = {
  'grip steer 1 for 0.6 s -> 0': '6c993e7d:0.62999594920003688',
  'grip steer -0.5 for 0.3 s -> 0': '40d52a77:-0.15749949968856924',
  'lane change: full steer until x >= 0.25, then 0': '92299598:0.35874596835978673',
  'drift left 1 s, release': '792b944b:-0.46163025864365348',
  'drift right at the floor 1 s, release': '05cd6ead:0.22482389451285265',
  'seeded steer and drift, straight': 'a9afafa2:-0.74763181996900985',
  'grip medium inward 2 s -> 0': '282234fa:-2.8737999860935415',
  'grip hard inward 2 s -> 0': '9b60c81c:-3.3488448519612324',
  'grip sharp left inward 2 s -> 0': '74d2cb22:3.0373193683256794',
  'drift hard left 0.87 3 s -> release': 'd37d6103:2.2599681868893606',
  'drift medium right floor 3 s -> release': '04e39344:-2.0018997951082946',
  'drift sharp left full 3 s -> release': 'd95a4107:2.2342951915497351',
  'drift hard into a straight, release on the straight': '668cf6d7:-0.39550637215058948',
  'seeded steer and drift, test-twisty': '35011784:5.5080289242395217',
  'seeded steer, GRIP only, test-twisty': '2de23ea5:1.3542116195854197',
};
export const PIN_STRAIGHT: Record<string, string> = {
  'grip steer 1 for 0.6 s -> 0': 'b235ec0e:0.68999556336317980',
  'grip steer -0.5 for 0.3 s -> 0': '6bcdf590:-0.17249944614281731',
  'lane change: full steer until x >= 0.25, then 0': '36fbc1d9:0.26832893173811340',
  'drift left 1 s, release': 'e2619791:-0.58358249530240613',
  'drift right at the floor 1 s, release': '7e72397e:0.25429329215933150',
  'seeded steer and drift, straight': '75195858:-0.75709473589045417',
};
export const PIN_HELD: Record<string, string> = {
  'held drift easy, dir -1, steer 0 toward dir': '23f24852:-0.35735916229463954',
  'held drift easy, dir -1, steer 0.5 toward dir': '79468cca:-0.35875272267433972',
  'held drift easy, dir -1, steer 1 toward dir': 'f1b93ede:-1.1001926562674560',
  'held drift easy, dir 1, steer 0 toward dir': '5f34cb52:0.35735916229463954',
  'held drift easy, dir 1, steer 1 toward dir': 'd55b4dde:1.1001926562674560',
  'held drift medium, dir -1, steer 0 toward dir': '408024cc:0.079616069226286765',
  'held drift medium, dir -1, steer 0.5 toward dir': 'baf582d0:0.079616069226286765',
  'held drift medium, dir -1, steer 1 toward dir': '8239b0c3:-0.59546060136827006',
  'held drift medium, dir 1, steer 0 toward dir': '9ebe11cc:-0.079616069226286765',
  'held drift medium, dir 1, steer 1 toward dir': '02d7b8c3:0.59546060136827006',
  'held drift hard, dir -1, steer 0 toward dir': 'f7e39efa:0.49388515396701843',
  'held drift hard, dir -1, steer 0.5 toward dir': 'ebf332b2:0.49388515396701843',
  'held drift hard, dir -1, steer 1 toward dir': 'f54e1b4c:-0.18119151662753868',
  'held drift hard, dir 1, steer 0 toward dir': 'fb7e3cfa:-0.49388515396701843',
  'held drift hard, dir 1, steer 1 toward dir': '5f277e4c:0.18119151662753868',
  'held drift sharp, dir -1, steer 0 toward dir': 'f3b2b647:0.70872511626026669',
  'held drift sharp, dir -1, steer 0.5 toward dir': '395de583:0.70872511626026669',
  'held drift sharp, dir -1, steer 1 toward dir': '4923fbce:0.033648445665710715',
  'held drift sharp, dir 1, steer 0 toward dir': 'c0e19547:-0.70872511626026669',
  'held drift sharp, dir 1, steer 1 toward dir': '5bf7a7ce:-0.033648445665710715',
  'held drift against the corner (hard right, dir -1, steer -1)': '36e56d6e:-3.3272264119341464',
};
