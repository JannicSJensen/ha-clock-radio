# Home Assistant alarm helpers

The optional [package](clock_radio_alarms.yaml) runs alarms in Home Assistant,
independently of an open tablet or the Clock Radio app process. It requires the
Music Assistant integration and a Music Assistant speaker with volume and repeat
support. After installing it, Clock Radio's **Alarm configuration** page edits
these same profiles directly; **Add alarm** creates additional persistent profiles
and **Delete** removes or disables/hides them after confirmation. Native HA
entities cards remain an alternative.

## Optional manual clock color test

The independent [night-mode helper](clock_radio_night_mode.yaml) adds
`input_select.clock_radio_night_override` with **Auto / Day / Night**.
With Clock Radio 0.13.0+, Auto follows the app's configured night mode, while
Day and Night force their respective clock colors for testing. Return to Auto
after testing; the helper restores its last selection across restarts.

This helper needs neither the alarm package nor Music Assistant. Either create
a Dropdown helper with that entity ID and those options in HA's Helpers UI, or
copy the standalone YAML file into your HA packages directory, check
configuration and reload input selects (restart HA if necessary).
Do not install duplicate definitions if the helper already exists.
See the [clock configuration guide](../../clock-radio/DOCS.md#manual-clock-color-test)
for behavior, status and error handling. The alarm package below uses
scheduler protocol 7.

## Install

1. Enable packages in your HA configuration if they are not already enabled:

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

2. Copy `clock_radio_alarms.yaml` into that `packages` directory. Do not overwrite
   another package or duplicate an existing `homeassistant:` section.
3. Check configuration. Reload input booleans, numbers, selects, text, date/time, timers,
   templates, scripts and automations; restart HA if a required integration has
   not previously been loaded.
4. Run `script.clock_radio_initialize` once. It is guarded by
   `input_boolean.clock_radio_initialized`, so normal reloads/restarts do not
   reset your choices.
5. Set these helpers:
   - Set `media_player` in the Clock Radio HA app configuration to your Music
     Assistant speaker. The app safely updates `input_text.clock_radio_player`.
     Standalone native-HA use can still set that helper manually.
   - `input_text.clock_radio_music_source`: the default radio URI from your MA
     library, e.g. `library://radio/123`, or an HTTP(S) radio stream. Each Music
     alarm can override this by selecting a station in the app editor.
   - `input_text.clock_radio_buzzer_source`: a reachable HTTP(S) audio URL.
     For an existing HA file under `www/sounds/`, use an absolute URL such as
     `http://homeassistant:8123/local/sounds/wakeup.mp3` if that hostname is
     reachable from your Music Assistant server. A bare `/local/...` path is
     not a Music Assistant media URI. No sound file is bundled.
6. Use **Alarm configuration** in Clock Radio to edit alarms and add more, or add
   [alarm-cards.yaml](alarm-cards.yaml) as a manual card in a native HA dashboard.
   It uses standard entities cards, without HACS. Shared playback sources are
   configured through the HA helpers in step 5, not through the app.
7. Test a profile from Developer tools > Actions using
   `script.clock_radio_play_alarm` with a profile ID such as `alarm: "1"` or `"3"`. This manual
   action intentionally works even when the schedule is disabled.

## Defaults and controls

| Profile | Type | Wake time | Weekdays | Duration | Volume | Enabled |
| --- | --- | --- | --- | --- | --- | --- |
| Alarm 1 | Music | 06:00 | Monday-Friday | 5 minutes | 50% | No |
| Alarm 2 | Buzzer | 06:15 | Monday-Friday | 5 minutes | 50% | No |

Each profile has its own enable switch, type selector, hour/minute helpers, wake
time display in Alarm configuration, seven weekday switches, volume, duration and countdown timer.
The app presents these as a compact alarm list and a wheel-time editor with
repeat-day buttons. List enable switches save immediately; editor changes use
Save or Cancel. Cancel does not modify the HA helpers.
Any profile can be Music or Buzzer. The speaker, default Music source and Buzzer
sound are shared; each profile can override its Music station. Values restore
across restarts rather than being reset by YAML
`initial` fields.

## Per-alarm Music Assistant radio

Scheduler package **version 5** adds restoring
`input_text.clock_radio_alarm_N_music_source` helpers, maximum 255 characters.
The package defines these for bundled profiles 1/2. Update the installed package,
check configuration and reload input text, templates and scripts; do not reset
existing helper values or initialization flags.

In the app editor, choose **Music**, select a radio below **Alarm type** and Save.
The list comes from HA's Music Assistant radio library, including station logos,
without requiring MA browsing credentials. Selecting does not play audio.
**Use shared HA default** stores an empty override. Music playback falls back
to `input_text.clock_radio_music_source` only when the profile's helper is empty
or absent; unavailable/invalid helpers fail explicitly rather than playing a
different station.

Scheduler package **version 7** also supports an optional
`input_text.clock_radio_alarm_N_buzzer_source`. The app creates this restoring
native helper on the first saved Buzzer sound selection, including for bundled
profiles 1/2; do not duplicate it in YAML. When absent or empty, Buzzer uses
`input_text.clock_radio_buzzer_source` as before. Unknown/unavailable overrides
fail explicitly rather than playing a different sound. Both manual/scheduled
starts and captured Buzzer Snooze resumption use the profile's current sound.

Clock Radio 0.16.0 includes twelve original MIT-licensed WAVs and local browser
previews. Updating/restarting the app publishes them through its HA configuration
mount to `www/clock-radio/sounds/v1/`. Configure a speaker-accessible HA internal
URL under **Settings > System > Network** (external URL is used only if internal
is unset). If `www` is new, restart HA once to expose `/local/`. Audio URLs do
not include access tokens. The app verifies audio is reachable before saving.
For a version 6 to 7 package upgrade, check configuration and reload scripts and
templates only; do not reinitialize helpers. See the
[Buzzer sound setup](../../clock-radio/DOCS.md#buzzer-alarm-sounds) for standalone
hosting and the complete sound collection. Existing sound choices are unchanged.

New app-created profiles include their source helper. Existing app-created
profiles acquire it on their first saved station selection through HA's
admin-only helper API. The source survives restarts and works with the app
closed. Native HA users may set the same helper to a Music Assistant radio URI
or HTTP(S) stream. Other profile settings and shared sources remain unchanged.

Scheduling uses **Home Assistant's time zone**, checked at the start of each
minute. It does not replay alarms missed while HA was stopped. Profiles can
be enabled independently; when their playback overlaps, the later start replaces
the earlier alarm because they share one speaker. Changing a schedule does not
immediately trigger it in the middle of a minute.

Music replaces the speaker's MA queue with the configured radio station. Buzzer
repeats the configured sound until its own countdown expires. A playback startup
failure is logged and produces a persistent notification. Stop any running alarm
with `script.clock_radio_stop`; disabling its schedule only prevents future
starts. Automatic/manual stop restores the speaker's previous volume and repeat
setting, but does **not** restore an interrupted queue or resume previous music.

## Ringing screen and 10-minute Snooze

The app automatically shows a dedicated ringing screen, not the ordinary music
artwork player. Both alarm types offer **Snooze** and **slide to stop**; Music
also has a mini player. Drag the stop knob to the right and release (at least
90% travel), or press End then Enter. Escape/page navigation does not dismiss
the screen. It returns to the previous page when HA confirms the alarm ended.
The wake countdown remains separate from the fixed **10-minute** snooze.

For an existing installation, replace this package including its new helpers,
check configuration and reload the affected integrations. It now exposes
`sensor.clock_radio_alarm_scheduler_version: 7`. Add
`input_text.clock_radio_active_alarm`, `input_text.clock_radio_snoozed_alarm`
and `input_datetime.clock_radio_snooze_until`, plus the deletion helpers below;
do not reset existing profile or
initialization helpers. Restart HA if date/time helpers were not loaded before.
Older packages retain Stop and the ringing screen, but the app requires version 6
for reliable Snooze.

`script.clock_radio_snooze` captures the ringing profile/type, stops playback
and restores the speaker, then persists a deadline 600 seconds away.
The deadline rounds up to a whole second so it matches HA's time-trigger
precision. The due check also accepts older fractional deadlines at their
displayed whole second. A minute-based recovery trigger catches due snoozes
missed during automation reloads; clearing the captured context prevents repeats.
To upgrade an existing version 5 installation, replace the package, check
configuration and reload scripts, automations and template entities. No new
helpers or reinitialization are required. Cancel any overdue snooze before
reloading if you do not want it to ring immediately.
`script.clock_radio_resume_snooze` starts it once when due, even if its schedule
is disabled. The captured type is preserved through edits; current
volume/duration, per-profile Music source and shared speaker/Buzzer settings are
used when it resumes.
The app may be closed. Future deadlines survive HA restarts; overdue snoozes
resume once during startup. A new alarm or `script.clock_radio_stop` cancels a
pending snooze. The app exposes **Cancel snoozed alarm** in Alarm configuration
and shows the snooze deadline as the next alarm when earlier than the schedule.
Do not manually edit the captured JSON helper values.

## Alarm deletion and recovery

Version 4 adds `script.clock_radio_prepare_delete`,
`input_text.clock_radio_deleting_alarm`, and
`input_boolean.clock_radio_alarm_1_deleted` /
`input_boolean.clock_radio_alarm_2_deleted`. Replace the installed package
including these helpers, scripts, template and automations; check configuration
and reload the affected integrations. Keep all existing settings and
initialization flags. New deletion helpers intentionally restore their values.

Delete in the app confirms the action, freezes the selected profile, waits for
in-flight alarm scripts and stops/cancels only its own ringing playback/timer or
Snooze. Other alarms and ordinary music are left alone. The app then removes
app-created native helpers using HA's admin-only APIs. Bundled profiles 1/2
instead have their restoring deleted flags enabled; their YAML definitions and
saved helper values remain, but neither scheduling, manual playback nor Snooze
can start them. Native entities cards may still display those retained helpers.

The deletion marker clears only after successful removal. If a helper deletion
or speaker cleanup fails, the app reports it and keeps the profile disabled and
visible for **retry Delete**. Finish that deletion before adding another profile
or deleting a different one. Do not manually clear the coordination marker or
reset initialization: that would bypass recovery for a partially removed profile.
Opening/restarting the app or HA does not undo a completed or pending deletion.

Countdowns restore on HA restart, and startup cleanup stops any alarm that was
active before the restart without cancelling a pending snooze.
For critical wake-ups, keep an independent backup:
HA, Music Assistant, the network and speaker must all be available.
