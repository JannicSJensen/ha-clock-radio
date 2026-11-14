# Home Assistant alarm helpers

The optional [package](clock_radio_alarms.yaml) runs alarms in Home Assistant,
independently of an open tablet or the Clock Radio app process. It requires the
Music Assistant integration and a Music Assistant speaker with volume and repeat
support. After installing it, Clock Radio's **Alarm configuration** page edits
these same profiles directly; **Add alarm** creates additional persistent profiles. Native HA
entities cards remain an alternative.

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
   - `input_text.clock_radio_music_source`: a radio URI from your MA library,
     e.g. `library://radio/123`, or an HTTP(S) radio stream.
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
Any profile can be Music or Buzzer. Playback sources and the speaker are
shared settings. Values restore across restarts rather than being reset by YAML
`initial` fields.

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
`sensor.clock_radio_alarm_scheduler_version: 3`. Add
`input_text.clock_radio_active_alarm`, `input_text.clock_radio_snoozed_alarm`
and `input_datetime.clock_radio_snooze_until`; do not reset existing profile or
initialization helpers. Restart HA if date/time helpers were not loaded before.
Older packages retain Stop and the ringing screen, but cannot Snooze.

`script.clock_radio_snooze` captures the ringing profile/type, stops playback
and restores the speaker, then persists a deadline 600 seconds away.
`script.clock_radio_resume_snooze` starts it once when due, even if its schedule
is disabled. The captured type is preserved through edits; current
volume/duration and shared speaker/source settings are used when it resumes.
The app may be closed. Future deadlines survive HA restarts; overdue snoozes
resume once during startup. A new alarm or `script.clock_radio_stop` cancels a
pending snooze. The app exposes **Cancel snoozed alarm** in Alarm configuration
and shows the snooze deadline as the next alarm when earlier than the schedule.
Do not manually edit the captured JSON helper values.

Countdowns restore on HA restart, and startup cleanup stops any alarm that was
active before the restart without cancelling a pending snooze.
For critical wake-ups, keep an independent backup:
HA, Music Assistant, the network and speaker must all be available.
