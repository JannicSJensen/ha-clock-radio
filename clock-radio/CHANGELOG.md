# Changelog

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
