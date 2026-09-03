/**
 * Every site-specific selector lives here so selector drift is a one-file fix.
 * Use the `debug_snapshot` tool to inspect the live page when something breaks.
 *
 * music.amazon.com is built from Stencil web components (`music-*`) with OPEN
 * shadow roots, so plain CSS selectors pierce them in Playwright.
 *
 * Everything below was verified against the live site on 2026-09-03
 * (logged-out surface first, then the signed-in player bar).
 */
export const SEL = {
  /** Present once the app shell has hydrated. */
  appReady: '#music-navbar, music-app',
  /** Only rendered while logged out. */
  signInButton: 'music-button[href^="/forceSignIn"]',
  searchInput: 'input#navbarSearchInput',
  /** Search result sections; `primary-text` = "Top Results" | "Songs" | ... */
  shoveler: 'music-shoveler',
  /** Result rows. Data lives in light-DOM attributes: primary-text, secondary-text, primary-href, image-src.
   *  `music-image-row[loading]` rows are skeletons with no attributes. */
  item: 'music-horizontal-item, music-vertical-item, music-image-row:not([loading])',
  /** A hydrated result row (the player bar's mini now-playing row is also a music-horizontal-item; exclude it). */
  itemReady: 'music-horizontal-item[primary-text]:not(#miniNPVTrackInfo), music-vertical-item[primary-text]',
  /** Per-item play control (inside the item's shadow root). */
  itemPlayButton: 'music-playback-button button, music-button[icon-name="play"] button',
  /** Per-item "more" control (opens the row's context menu: Play Next, Add to Queue, ...). */
  itemMoreButton: 'music-button[icon-name="more"] button',
  /** Play control in an album/playlist/artist detail header. */
  detailPlayButton:
    'music-detail-header music-playback-button button, music-detail-header music-button[icon-name="play"] button, music-button[icon-name="play"][size="large"] button',

  transport: {
    /** The player bar (light DOM div). */
    root: '#transport',
    /** Mini now-playing row: primary-text (title), secondary-text (artist), secondary-text-2 (album),
     *  image-src (artwork), secondary-href (artist page), secondary-href-2 (album page). */
    nowPlaying: '#miniNPVTrackInfo',
    /** role=slider with aria-valuenow (s), aria-valuemax (s), aria-valuetext "mm:ss/mm:ss". */
    progress: '#progress-container[role="slider"]',
    /** Accessible names of the bar's buttons (each lives in a music-button shadow root).
     *  Labels name the CURRENT state for play/pause and the NEXT action for shuffle/repeat. */
    playPause: /^(play|pause)$/i,
    next: /^next$/i,
    previous: /^previous$/i,
    shuffle: /shuffle/i, // "Turn On Shuffle" | "Turn Off Shuffle"
    repeat: /repeat/i, // "Repeat All Songs" | "Repeat One Song" | "Turn Off Repeat"
    like: /like/i, // "Like" | "Unlike"
    more: /^context menu$/i,
    volume: /^volume$/i,
    /** Appears after clicking the Volume button. type=range min=0 max=1 step=0.01. */
    volumeRange: '#volume-range',
    queueToggle: /playqueue/i, // "Open PlayQueue" | "Close PlayQueue"
    /** Mini-row button that opens the full Now Playing View ("maximize") / closes it ("Minimize Player"). */
    npvOpen: /^maximize$/i,
    npvClose: /^minimize player$/i,
  },

  /** Full Now Playing View (open via transport.npvOpen). */
  npv: {
    /** Exists ONLY while the view is open — the mini row's icon-name lags and cannot be trusted. */
    root: '#npv',
    /** Its own close button (the "Minimize Player" control lives here, not in #transport). */
    closeButton: '#npvCloseButton',
    /** Lyric lines; the current line's computed color is fully opaque, the rest are dimmed. */
    lyrics: 'ol[aria-label="All lyrics"] li',
    /** The artist hero background (inline background-image on a page-sized div). */
    background: '[style*="background-image"]',
    /** The quality badge; clicking it opens the dialog with real bit depth / sample rate. */
    qualityTag: '#npv music-tag[aria-label="ULTRA HD"], #npv music-tag[aria-label="HD"], #npv music-tag[aria-label*="ATMOS" i], #npv music-tag[katana-color="HD"]',
  },

  settings: {
    gear: /^go to settings$/i,
    autoplayItem: 'music-list-item[primary-text="Autoplay"]',
  },

  queue: {
    overlay: '#transport-overlay',
    /** Rows: primary-text, primary-href, secondary-text-1 (artist), secondary-text-2 (album), image-src. */
    row: '#transport-overlay music-image-row:not([loading])',
  },

  library: {
    playlistsPath: '/my/playlists',
    playlistItem: 'music-vertical-item, music-horizontal-item, music-image-row:not([loading])',
  },

  menu: {
    root: '[role="menu"]',
    /** Context-menu entries are music-list-item[role=menuitem]; their label is in attributes/shadow text. */
    item: 'music-list-item[role="menuitem"], [role="menuitem"]',
    addToPlaylist: /add to (a |new )?playlist/i,
    /** Per-result context menu (song/album rows): "Play Next", "Add to Queue". */
    playNext: /^play next$/i,
    addToQueue: /^add to queue$/i,
    /** The playlist picker opened by "Add to Playlist". */
    dialog: '#dialog[role="dialog"], [role="dialog"]',
    /** Its rows carry primary-text (playlist name); "Create Playlist" is one of them. */
    dialogRow: '[primary-text]',
  },
} as const;
