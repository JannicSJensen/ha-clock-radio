# Changelog

## 0.27.0

- Show a mini-player beside the Clock while the configured Music speaker is
  playing, with pause, volume and access to the full player. Ringing alarms
  and snooze controls take priority.

## 0.26.1

- Remove the explanatory native-tone, device-wide alarm-settings and music
  fallback paragraphs from the KS alarm editor.
- Hide the empty tone status after loading succeeds; retain tone refresh,
  loading/errors and all alarm controls and saved choices.

## 0.26.0

- Simplify KS alarm music selection: remove Use Kiosk music default, Music
  from and Plays on controls while retaining radio/category browsing.
- Pin new selections to Music Assistant and its show-01 speaker. Confirm
  the exact available target before showing choices; never substitute a
  different speaker if show-01 is missing, ambiguous or unavailable.
- Preserve saved alarm music, inherited native defaults and HA-backed
  behavior. Browsing does not change KS's global source/speaker or play audio.

## 0.25.1

- Remove experimental KS support banners from the pages and experimental
  wording from current configuration help and documentation.
- Keep native connection, setup and ringing-control errors visible without
  routine success notices. Preserve saved alarms, native scheduling/playback
  and backend-switching safety warnings.

## 0.25.0

- Add Proximity screen dimming to Settings with either alarm backend.
  Configure KS's native Dim screensaver for 10 minutes of inactivity and
  a 10% dim level, with proximity postponing or waking it.
- Leave Clock Radio visible and brightness restoration on KS; preserve
  normal/adaptive brightness settings and native alarm schedules.
- Validate sensor support and saved settings, block read-only/offline
  changes and active alarms, and refuse conflicting native schedules or
  lockdown instead of silently overriding them.
- Use no browser inactivity timer and keep native dimming independent of
  HA connectivity. Configuration defaults off until explicitly saved.

## 0.24.0

- Add Settings controls to check and install Kiosk Satellite updates using
  the configured KS address/token with either HA or KS alarm scheduling.
- Show installed/available versions and native download/install status.
  Require confirmation, a matching offer/device and idle native alarms;
  preserve KS's update source, APK selection and Android installer.
- Keep credentials on the server. Block read-only/offline installation and
  duplicate requests; never retry installation automatically or report it
  complete before KS reports a newer installed version.
- Keep native update controls independent of HA connectivity. Fictional
  development fixtures simulate updates without installing an APK.

## 0.23.1

- Remove the introductory KS alarm-selection paragraph from the Alarm page,
  while preserving native connection errors and other status notices.

## 0.23.0

- Add opt-in Clock Radio ringing and snooze UI for native KS alarms using
  a device-local, acknowledged presentation lease. KS retains scheduling,
  playback, volume ramp, snooze timing and native emergency controls.
- Require matching native capabilities, device identity and KS's trusted
  Dashboard alarm UI URL. Existing KS versions keep their native screen;
  this feature requires the coordinated upstream KS enhancement.
- Reuse Snooze and Slide to Stop with exact native occurrence/group context.
  Leave unrelated or mixed groups to KS. Never invoke unscoped remote controls.
- Renew presentation only after controls render. Hidden, offline, read-only,
  mismatched or failed pages release the lease; KS restores native controls
  within four seconds if heartbeats stop. Native music controls remain native.

## 0.22.0

- Add Left/Right arrow-key page navigation alongside Page Up/Down.
  Up/Down changes the previous/next view of the focused split Clock panel.
- Make Clock face/widget panels focusable with Tab or a click/tap, show
  keyboard focus, and restore the selected panel after saving its view.
- Preserve input, slider, editable-content and dialog keyboard controls.
  Modifier shortcuts and held-key repeats do not trigger navigation.
  Update keyboard guidance for new and existing browsers.

## 0.21.0

- Swap touch navigation axes: swipe left/right between the four main pages,
  and up/down within the split Clock's face or widget panel.
- Keep vertical list scrolling and horizontal music carousels/tab strips
  scrollable without changing pages mid-scroll. Music categories are now
  selected by tapping tabs, avoiding conflicting horizontal navigation.
- Update navigation hints, including a fresh hint for existing browsers.
  Keyboard Page Up/Down, dialog/control guards and saved Clock choices remain
  unchanged.

## 0.20.0

- Keep alarm sound configuration in Clock Radio for both backends. Kiosk
  alarms can select music/radios, their speaker, and native buzzer/fallback
  tones in the existing alarm editor.
- Browse Kiosk's configured Music Assistant, Home Assistant and Sonos sources
  on demand, including paged lists and folders. Never force Sendspin or start
  playback while browsing/saving. Direct-URL native alarms remain unsupported.
- Preserve saved native music and tones during schedule edits and enable
  toggles. Following Kiosk's music or tone default is now an explicit choice.
  Existing alarms are not migrated or rewritten on upgrade.
- Keep credentials, raw music records and device paths server-side. Validate
  choices, recheck speaker/tone availability and active-alarm state, confirm
  saves on Kiosk, and retain read-only offline snapshots. HA selectors and
  playback behavior are unchanged.

## 0.19.1

- Make experimental Kiosk-backed Music alarms follow Kiosk's own
  **Settings > Alarms > Alarm music** choice, including source, radio and
  speaker. Configure and preview Music > Radios in Kiosk's native picker.
  Clock Radio no longer forces a Music Assistant source or local Sendspin player.
- Remove the Kiosk radio picker and catalog polling from Clock Radio.
  Buzzer still explicitly uses the saved native tone; Music inherits the
  live Kiosk default, with the native tone when no music is configured or
  playback cannot start.
- Leave saved alarms untouched on update. Saving or toggling a Music alarm
  removes its previous per-alarm music override and verifies inheritance.
  Existing users should save their Music alarms once after updating.
  Default HA-backed alarms and the HA Music page are unchanged.

## 0.19.0

- Add an opt-in experimental `kiosk_satellite` alarm backend in the HA app
  configuration, with a Remote Administration URL and server-only API token.
  `home_assistant` remains the default; no schedules are migrated or disabled.
- Keep Clock Radio's alarm list/time/repeat/type editor while storing marked
  test alarms on Kiosk. Confirm changes by reading them back. Native execution
  does not depend on HA or the dashboard; editing still needs the app server.
- Support Kiosk's own Music Assistant radio library and local Sendspin player,
  with a saved native tone as fallback. Buzzer drafts use the built-in tone.
  Kiosk supplies volume/auto-silence defaults and the native ringing screen.
- Keep unrelated native alarms untouched. Disable test alarms before deletion;
  stop active alarms before edits. Stop/Snooze stay on Kiosk because its Remote
  API applies those actions to every simultaneous native alarm.
- Separate Kiosk alarm readiness from HA music/settings readiness and retain
  backend/device-scoped read-only snapshots. Tokens and native music URIs never
  enter browser snapshots. Turning the backend off does not cancel native alarms.

## 0.18.0

- Keep a validated, read-only browser snapshot of clock settings and alarm
  definitions. Restore it before connecting and retain it across HA outages
  and browser reloads when the dashboard assets can still load.
- Show explicit offline/last-synchronized status and storage errors. Cached
  data never enables controls, recreates ringing/Snooze state, stores source
  URLs or credentials, or queues/replays changes. Fresh HA data replaces it.
- Bound browser requests: 8 seconds for state, 30 seconds for other reads and
  ordinary changes, and 120 seconds for alarm creation/deletion. Timed-out
  changes warn that they may still complete; they are never retried automatically.
- No local alarm execution, offline app-shell guarantee or HA package change.

## 0.17.0

- Return Alarm configuration, Music and Settings to The Clock after two minutes
  of inactivity. Configure `return_to_clock_minutes` in the HA app options
  (0-1440 whole minutes; `0` disables it), then restart the app.
- Touch, pointer, scroll and keyboard activity restart the countdown. Open
  editors/dialogs, ringing alarms, held pointers and pending saves pause it.
  Polling does not reset it; overdue background pages return when visible again.
- Keep music playing, HA alarm schedules unchanged and unsaved inline Settings
  drafts intact. No HA scheduler package update is required.

## 0.16.0

- Add twelve original, MIT-licensed Buzzer alarm sounds with a separate saved
  choice for each alarm. Existing alarms keep their shared HA sound by default.
- Preview a sound on the tablet/browser without playing the HA speaker.
  Selection drafts survive polling; Cancel, unrelated edits and enable switches
  preserve saved sound choices.
- Publish bundled WAVs to HA's `www/clock-radio/sounds/v1` folder on app startup
  using the new HA configuration mount. Public audio requests never include
  access tokens. Read-only mode does not install files.
- Require scheduler package version 7 for per-alarm Buzzer playback, including
  Snooze resumption. Verify HA's configured internal/external audio URL before
  saving; source errors remain visible instead of selecting another sound.

## 0.15.2

- Fix Music/Buzzer snoozes failing to ring again when HA's whole-second time
  trigger ran before a fractional-second stored deadline.
- Scheduler package version 6 stores whole-second deadlines, accepts legacy
  fractional deadlines at the trigger's precision and retries missed due
  snoozes once per minute without starting an alarm twice.
- Require the corrected HA package before offering new snoozes; existing
  ringing alarms retain Stop. Update the installed package and reload scripts,
  automations and templates; updating the app alone cannot repair HA scheduling.

## 0.15.1

- Cache and revalidate static browser assets with content ETags, returning
  body-free 304 responses while keeping updates and local edits fresh.
- Reuse file reads/compressed representations and gzip larger text assets
  without recompressing fonts or caching live API responses and commands.
- Defer Music's UI and library loading until its first visit instead of
  fetching recommendations in the background on the Clock page.

## 0.15.0

- Replace the clock widget with a live countdown while Music or Buzzer alarms
  are snoozed, with the ringing screen's slide-to-stop control.
- Restore the saved layout/widget when HA clears snooze. Keep deadline ticking,
  night colors, portrait layout, read-only/disconnected guards, confirmation and
  retryable errors consistent with the clock and ringing screen.
- Scope snooze stop requests to the current ID, type and deadline so stale
  controls cannot dismiss a replacement alarm. Keep existing stop requests
  compatible and require no HA package update.

## 0.14.4

- Initialize and verify newly created Music Source helpers before marking an
  alarm ready, fixing disabled radio selection caused by HA's `unknown` state.
- Recover unknown sources during incomplete setup retries while preserving saved
  stations and other helper edits. Keep failed/no-op initialization recoverable
  and genuinely unavailable helpers explicit.
- Match native text-helper defaults in the demo/tests and document one-time
  recovery for already-complete profiles created by older releases.

## 0.14.3

- Remove numbered alarm names from the list, editor, delete confirmation,
  notifications, accessibility labels and ringing screen.
- Identify row controls and delete targets by time, type and repeat days.
  Keep internal HA profile/helper IDs and command targeting unchanged.
- Refresh the affected Alarm and ringing-screen documentation screenshots.

## 0.14.2

- Remove the two explanatory lines above the Alarm list, while retaining
  setup/deletion warnings, errors and alarm controls.
- Refresh the affected Alarm documentation screenshots.

## 0.14.1

- Use pure black for the shared app canvas and all four main-page backgrounds,
  fixing the Alarm page and loading/disconnected gaps rather than relying on
  page-specific overrides.
- Preserve card/control/dialog contrast and configurable clock colors. Add
  shared-background asset checks and refresh the affected Alarm screenshots.

## 0.14.0

- Reorder the main pages to Clock, Alarm configuration, Music overview, Settings.
  Swipes, Page Up/Down, bottom dots and screen-reader positions use this order.
- Update the Alarm navigation hint, documentation and affected screenshots.
  Existing page links and dialog navigation safeguards are unchanged.

## 0.13.1

- Make the Music page canvas and bottom now-playing bar pure black across all
  tabs. Preserve contrasting station cards, controls and artwork-player styling.
- Refresh the Music documentation screenshot.

## 0.13.0

- Add optional `input_select.clock_radio_night_override` support for manual
  clock-color testing from HA: Auto follows the configured night mode, Day
  forces daytime colors and Night forces night color/brightness over black.
  Automatic settings, sensor hysteresis, alarms and music are left unchanged.
- Show the helper's selection in Settings. Missing optional helpers keep
  existing behavior; an installed helper becoming invalid/unavailable retains
  its last valid selection and reports an explicit warning.
- Include a standalone restoring HA helper package and setup instructions.
  No alarm scheduler package update is required.

## 0.12.0

- Add four persistent bottom dots to the main Clock, Music, Alarm configuration
  and Settings pages. The active dot is grey and the others are darker; the dots
  are non-interactive position indicators.
- Announce the page name and position to screen readers. Reserve footer space
  so the dots stay clear of playback controls, Save actions and status banners,
  and dim the indicator with the clock's night mode.
- Refresh the main-page and Sun night-mode documentation screenshots.

## 0.11.0

- Redesign Settings with an iOS-inspired black appearance: rounded grouped
  lists, subtle separators, colorful section icons, trailing values, color
  swatches and a native keyboard-accessible seconds switch.
- Keep Save changes and Reload values in a floating action bar that stays clear
  of connection/error banners. Preserve all clock settings, unsaved drafts,
  polling focus, explicit save errors and read-only/disconnected safeguards.
- Show the configured Weather and Sun entities as read-only rows, keep their
  HA app configuration guidance, and add links to Alarms and The Clock.
- Refresh the Settings and Sun night-mode documentation screenshots.

## 0.10.1

- Add a Sun entity field to the HA app configuration, defaulting to `sun.sun`.
  Sun night mode follows the configured entity; Settings shows its ID and
  explains where to change it.
- Validate the option at startup. Missing/empty retains the default for existing
  installations; an unavailable/invalid configured entity reports an explicit
  warning and retains the last night state instead of using a different entity.

## 0.10.0

- Show Music Assistant radio names/logos below Alarm type in the Music alarm
  editor. Select a station independently for each alarm and Save; Cancel and
  switching types preserve normal draft behavior without starting playback.
- Persist each station in HA for scheduled/manual playback and Snooze, with an
  explicit shared-default option. Buzzer playback is unchanged.
- Require scheduler package version 5 for radio selection. Include restoring
  source helpers for bundled/new profiles, migrate existing native profiles on
  first selection and delete their source helper with the alarm.
- Preserve old-package editing and existing sources. Report missing libraries,
  unavailable helpers and failed writes; retain saved choices during polling.
- Document installation, fallback and migration with a demo radio-picker screenshot.

## 0.9.0

- Add confirmed Delete actions to alarm rows and the editor, including incomplete
  profiles. Keep alarm/Escape cancel without changing HA or an editor draft.
- Stop/cancel only the selected profile's ringing playback, timer and Snooze.
  Remove app-created native helpers; persistently disable/hide bundled YAML
  profiles while retaining their definitions.
- Require HA scheduler package version 4. Freeze deletions in a restoring helper,
  verify cleanup, serialize conflicting writes and expose partial failures for
  safe retry without recreating deleted helpers.
- Add a screenshot gallery and illustrated configuration/deletion documentation
  using fictional demo data only.

## 0.8.1

- Accept the ready-made radio artwork URLs returned by Home Assistant's Music
  Assistant integration, including when MA browsing is not configured.
- Use known station logos for radio tiles, now playing and the ringing Music
  mini player instead of HA's sometimes-failing media-player image proxy.
  Preserve ordinary music artwork, server-side caching and credential isolation.

## 0.8.0

- Add a Sun night-mode option that automatically follows Home Assistant's
  `sun.sun`: below the horizon uses night color/brightness; above restores
  daytime colors without a schedule, threshold or entity selection.
- Preserve existing night-mode settings. Report missing/unavailable/invalid sun
  states explicitly and retain the last known night state until HA recovers.

## 0.7.0

- Automatically show a dedicated ringing-alarm screen with large time, an
  Apple-inspired buzzer layout, and an artwork/metadata mini player for Music.
- Add deliberate slide-to-stop with pointer cancellation, keyboard confirmation,
  explicit failures, HA-confirmed dismissal and previous-page restoration.
  Ordinary music never triggers the alarm screen.
- Add HA-backed 10-minute Snooze for both types, persistent through app/HA
  restarts, plus pending-snooze cancellation and next-alarm display.
- Capture the actual ringing profile/type in HA package version 3. Update the
  package including its new text/date-time helpers to enable Snooze; older
  packages retain the ringing screen and Stop without Snooze.

## 0.6.0

- Redesign Alarm configuration with a compact large-time list, immediate enable
  switches, and a focused touch-friendly editor inspired by Apple alarm controls.
- Add scroll-snap hour/minute wheels with keyboard support, 12/24-hour and AM/PM
  conversion, circular weekday buttons, repeat presets, and grouped existing
  Music/Buzzer, volume and wake-timer controls. No Label or Snooze fields are added.
- Save edits explicitly; Cancel/Escape makes no HA changes. Preserve drafts
  through polling, show save failures inside the editor, and retain setup
  recovery, read-only/disconnect guards and Stop active alarm.

## 0.5.1

- Remove the Alarm playback section from Alarm configuration. Keep profile
  editing, alarm creation and Stop active alarm; shared Music/Buzzer sources
  remain configured through their existing Home Assistant helpers.

## 0.5.0

- Split Settings into an Alarm configuration page for alarm profiles, creation
  and playback, and a Settings page for clock appearance and Music Assistant.
- Extend vertical swipes, keyboard navigation and direct links to four pages:
  The Clock, Music overview, Alarm configuration and Settings. Preserve unsaved
  edits and the existing read-only/disconnect policy on both configuration pages.

## 0.4.1

- Add weather entity configuration to the HA app options for weather widgets
  and full-screen clocks, with startup validation and clear setup instructions.
- Remove the dashboard weather entity selector. Existing `clock.weather_entity`
  YAML is accepted but ignored; copy it to the HA app option and restart.

## 0.4.0

- Replace the menu with vertical page swipes and keyboard Page Up/Down navigation.
- Swipe horizontally within split clock panels to save their face/widget views.
- Use one HA app-configured media player for Music and every alarm; remove speaker
  selection, grouping and Party.
- Add persistent HA alarm helpers and independent timers from Settings, with
  disabled defaults and recoverable partial setup. Generalize the HA scheduler.

## 0.3.0

- Streamline navigation to The Clock, Music overview and Settings.
- Adapt nightstand-clock's complete clock layouts/widgets, smooth/ticking
  seconds, locale/week-start, colors, weather/high-low and next-alarm display.
  Add HA illuminance/entity and scheduled night modes with hysteresis.
- Reuse Dasher's Music Assistant library tabs, speaker groups, recommendations,
  search/details, queue actions, Party QR and full-screen artwork player.
- Add persistent clock settings and an editor for the two existing HA alarm
  profiles, with independent times/weekdays/volumes/wake timers.
- Enforce read-only/disconnect policy across new mutations, proxy artwork
  without exposing tokens, and expand the fictional demo and integration tests.
- Preserve bundled Apache-2.0 and SIL Open Font licenses and document the
  renderer's timezone/live-data adaptations.

## 0.2.0

- Add an optional HA-native package with two independent alarm profiles,
  Music/Buzzer selectors, persistent hour/minute and weekday helpers, volume,
  duration, wake-time displays and automatic stop timers.
- Include native entities cards, guarded defaults, speaker cleanup and explicit
  playback failure notifications. Alarms run in HA, without an open tablet.

## 0.1.0

- Initialize a standalone Home Assistant clock-radio app using the Dasher
  foundation: Supervisor packaging, ingress, direct tablet access, Node.js
  server and a no-build vanilla JavaScript dashboard.
- Add a configurable clock/date, night palette, speaker discovery and selection,
  radio presets, playback and volume controls, and Music Assistant radio URIs.
- Add persistent validated YAML with hot reload, server-side command
  restrictions, read-only mode and visible connection/configuration errors.
- Include a fictional local demo, automated tests and GitHub Actions for tests,
  Home Assistant app linting and container builds.
