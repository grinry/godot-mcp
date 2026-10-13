@tool
extends RefCounted

# Portable shortcut text such as "CmdOrCtrl+Shift+A". CmdOrCtrl is Command on
# macOS and Ctrl elsewhere, using Godot's command_or_control_autoremap.
const DEFAULT = "CmdOrCtrl+Shift+A"
const SETTING = "godot_mcp/annotations/game_shortcut"
const ARGUMENT = "--godot-mcp-annotation-shortcut="
const MODIFIERS = ["cmdorctrl", "ctrl", "meta", "alt", "shift"]

static func is_modifier(keycode: Key) -> bool:
    return keycode in [KEY_SHIFT, KEY_CTRL, KEY_META, KEY_ALT]

static func command_is_meta() -> bool:
    return OS.has_feature("macos") or OS.has_feature("web_macos") or OS.has_feature("web_ios")

# Returns null unless text names one non-modifier key plus at least one
# modifier; function keys may be used alone.
static func parse(text: String) -> InputEventKey:
    var parts = text.strip_edges().split("+")
    var used = []
    for index in parts.size() - 1:
        var modifier = parts[index].strip_edges().to_lower()
        if not modifier in MODIFIERS or modifier in used:
            return null
        used.append(modifier)
    if "cmdorctrl" in used and ("ctrl" in used or "meta" in used):
        return null
    var keycode = OS.find_keycode_from_string(parts[-1].strip_edges())
    if keycode == KEY_NONE or is_modifier(keycode):
        return null
    if used.is_empty() and (keycode < KEY_F1 or keycode > KEY_F35):
        return null
    var event = InputEventKey.new()
    event.keycode = keycode
    # Godot refuses direct Ctrl/Meta writes while autoremap is enabled.
    if "cmdorctrl" in used:
        event.command_or_control_autoremap = true
    else:
        event.ctrl_pressed = "ctrl" in used
        event.meta_pressed = "meta" in used
    event.alt_pressed = "alt" in used
    event.shift_pressed = "shift" in used
    return event

static func normalize(text: String) -> String:
    return text if parse(text) != null else DEFAULT

static func from_arguments(arguments: PackedStringArray) -> InputEventKey:
    for index in range(arguments.size() - 1, -1, -1):
        if arguments[index].begins_with(ARGUMENT):
            var event = parse(arguments[index].trim_prefix(ARGUMENT))
            if event != null:
                return event
            push_warning("MCP annotations: invalid shortcut %s; using %s." % [arguments[index].trim_prefix(ARGUMENT), DEFAULT])
            break
    return parse(DEFAULT)

# Converts a pressed key into portable text, or "" when it is not usable.
static func from_event(event: InputEventKey) -> String:
    var keycode = event.keycode
    if keycode == KEY_NONE:
        keycode = DisplayServer.keyboard_get_keycode_from_physical(event.physical_keycode)
    if keycode == KEY_NONE or is_modifier(keycode):
        return ""
    var command = event.meta_pressed if command_is_meta() else event.ctrl_pressed
    var other = event.ctrl_pressed if command_is_meta() else event.meta_pressed
    var parts = []
    if command and not other:
        parts.append("CmdOrCtrl")
    else:
        if event.ctrl_pressed:
            parts.append("Ctrl")
        if event.meta_pressed:
            parts.append("Meta")
    if event.alt_pressed:
        parts.append("Alt")
    if event.shift_pressed:
        parts.append("Shift")
    parts.append(OS.get_keycode_string(keycode))
    var text = "+".join(parts)
    return text if parse(text) != null else ""

static func label(text: String) -> String:
    return parse(normalize(text)).as_text()

static func matches(shortcut: InputEventKey, event: InputEvent) -> bool:
    return event is InputEventKey and event.pressed and not event.echo and shortcut.is_match(event, true)
