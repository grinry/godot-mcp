extends SceneTree
const Codec = preload("variant_codec.gd")
var remaining = 1000

func fail(message):
    printerr(message)
    quit(1)

func pure_value(value, depth = 0):
    remaining -= 1
    if depth > 6 or remaining < 0:
        return {"ok": false, "error": "Setting value exceeds nesting/item limits"}
    if value is Dictionary and value.has("type"):
        var tags = {"Vector2": TYPE_VECTOR2, "Vector2i": TYPE_VECTOR2I, "Vector3": TYPE_VECTOR3, "Vector3i": TYPE_VECTOR3I, "Vector4": TYPE_VECTOR4, "Vector4i": TYPE_VECTOR4I, "Color": TYPE_COLOR, "Quaternion": TYPE_QUATERNION, "NodePath": TYPE_NODE_PATH, "StringName": TYPE_STRING_NAME}
        if tags.has(value.type):
            return Codec.decode(value, {"type": tags[value.type]})
        if value.type in ["Array", "Dictionary", "PackedStringArray"]:
            var tag = value.type
            value = value.get("value")
            if tag == "PackedStringArray":
                if not value is Array:
                    return {"ok": false, "error": "PackedStringArray requires string items"}
                remaining -= value.size()
                if remaining < 0: return {"ok": false, "error": "Setting value exceeds item limits"}
                for item in value:
                    if not item is String:
                        return {"ok": false, "error": "PackedStringArray requires string items"}
                return {"ok": true, "value": PackedStringArray(value)}
            if (tag == "Array" and not value is Array) or (tag == "Dictionary" and not value is Dictionary):
                return {"ok": false, "error": "Collection type tag mismatch"}
        else:
            return {"ok": false, "error": "Unsupported setting type tag"}
    if value is Array:
        var result = []
        for item in value:
            var converted = pure_value(item, depth + 1)
            if not converted.ok: return converted
            result.append(converted.value)
        return {"ok": true, "value": result}
    if value is Dictionary:
        var result = {}
        for key in value:
            var converted = pure_value(value[key], depth + 1)
            if not converted.ok: return converted
            result[key] = converted.value
        return {"ok": true, "value": result}
    if value is float:
        if not is_finite(value): return {"ok": false, "error": "Expected finite numbers"}
        if value == int(value): value = int(value)
    if value == null or value is String or value is bool or value is int or value is float:
        return {"ok": true, "value": value}
    return {"ok": false, "error": "Unsupported setting value"}

func make_event(spec):
    var event = null
    match spec.kind:
        "key":
            event = InputEventKey.new()
            if spec.has("key"):
                event.keycode = OS.find_keycode_from_string(spec.key)
                if event.keycode == 0: return {"ok": false, "error": "Unknown key name"}
            elif spec.has("keycode"): event.keycode = int(spec.keycode)
            else: event.physical_keycode = int(spec.physicalKeycode)
        "mouse_button":
            event = InputEventMouseButton.new()
            event.button_index = int(spec.button)
        "joypad_button":
            event = InputEventJoypadButton.new()
            event.button_index = int(spec.button)
        "joypad_motion":
            event = InputEventJoypadMotion.new()
            event.axis = int(spec.axis)
            event.axis_value = spec.axisValue
    event.device = int(spec.device)
    if event is InputEventWithModifiers:
        event.command_or_control_autoremap = spec.commandOrControl
        if not spec.commandOrControl: event.ctrl_pressed = spec.ctrl
        event.shift_pressed = spec.shift
        event.alt_pressed = spec.alt
        if not spec.commandOrControl: event.meta_pressed = spec.meta
    return {"ok": true, "value": event}

func event_info(event):
    var info = {"kind": "unsupported", "class": event.get_class(), "device": event.device}
    if event is InputEventKey:
        info.kind = "key"
        if event.keycode != 0 and event.physical_keycode == 0:
            info.keycode = event.keycode
        elif event.physical_keycode != 0 and event.keycode == 0:
            info.physicalKeycode = event.physical_keycode
        else:
            info.kind = "unsupported"
            info.keycode = event.keycode
            info.physicalKeycode = event.physical_keycode
    elif event is InputEventMouseButton:
        info.kind = "mouse_button"
        info.button = event.button_index
    elif event is InputEventJoypadButton:
        info.kind = "joypad_button"
        info.button = event.button_index
    elif event is InputEventJoypadMotion:
        info.kind = "joypad_motion"
        info.axis = event.axis
        info.axisValue = event.axis_value
    if event is InputEventWithModifiers:
        info.commandOrControl = event.command_or_control_autoremap
        info.ctrl = event.ctrl_pressed if not info.commandOrControl else false
        info.shift = event.shift_pressed
        info.alt = event.alt_pressed
        info.meta = event.meta_pressed if not info.commandOrControl else false
    if info.kind != "unsupported":
        var representable = event.device >= -1 and event.device <= 255
        if info.kind == "mouse_button": representable = representable and info.button >= 1 and info.button <= 9
        elif info.kind == "joypad_button": representable = representable and info.button >= 0 and info.button <= 127
        elif info.kind == "joypad_motion": representable = representable and info.axis >= 0 and info.axis <= 9 and (info.axisValue == -1 or info.axisValue == 1)
        elif info.kind == "key":
            var code = info.get("keycode", info.get("physicalKeycode", 0))
            representable = representable and code >= 1 and code <= 2147483647
        if representable:
            var rebuilt = make_event(info)
            representable = rebuilt.ok
            if representable:
                for property in event.get_property_list():
                    if property.usage & PROPERTY_USAGE_STORAGE and event.get(property.name) != rebuilt.value.get(property.name):
                        info.unsupportedProperty = str(property.name)
                        representable = false
                        break
        if representable:
            info.erase("class")
        else:
            info.kind = "unsupported"
            info.reason = "Stored fields cannot be preserved by the supported binding schema"
    return info

func _init():
    var args = OS.get_cmdline_user_args()
    if args.size() != 2:
        fail("Expected operation and JSON")
        return
    var params = JSON.parse_string(args[1])
    if not params is Dictionary:
        fail("Expected JSON object")
        return
    var config = ConfigFile.new()
    if config.load(params.inputPath) != OK:
        fail("Cannot parse project.godot configuration")
        return
    var operation = args[0]
    var section = params.section
    var key = params.get("key", "")
    var exists = config.has_section_key(section, key)
    if operation == "verify":
        var candidate = ConfigFile.new()
        if candidate.load(params.candidatePath) != OK:
            fail("Edited configuration failed to parse")
            return
        if params.expression == null:
            if candidate.has_section_key(section, key):
                fail("Removed configuration entry still exists")
                return
        else:
            var expected = ConfigFile.new()
            if expected.parse("[" + section + "]\n" + key + "=" + params.expression + "\n") != OK or not candidate.has_section_key(section, key) or var_to_str(candidate.get_value(section, key)) != var_to_str(expected.get_value(section, key)):
                fail("Edited configuration did not preserve the serialized value")
                return
        result({"verified": true})
        return
    if operation == "get_input_actions":
        var actions = []
        var keys = config.get_section_keys("input") if config.has_section("input") else PackedStringArray()
        var total = 0
        for action in keys:
            if key != "" and action != key: continue
            total += 1
            if actions.size() >= params.limit: continue
            var value = config.get_value("input", action)
            if not value is Dictionary or not value.get("events") is Array:
                fail("Malformed configured input action: " + action)
                return
            var events = []
            for event in value.events.slice(0, 32):
                if not event is InputEvent:
                    fail("Input action contains a non-event")
                    return
                events.append(event_info(event))
            actions.append({"action": action, "deadzone": value.get("deadzone", 0.5), "events": events, "eventsTruncated": value.events.size() > events.size()})
        result({"actions": actions, "total": total, "truncated": total > actions.size(), "configuredOnly": true})
        return
    var value = null
    if operation == "register_autoload":
        if ClassDB.class_exists(key):
            fail("Autoload name conflicts with a built-in class/reserved name")
            return
        value = params.autoload
        if exists and config.get_value(section, key) != value and not params.replace:
            fail("Autoload already exists; use replace:true to change it")
            return
    elif operation in ["unregister_autoload", "remove_input_action", "remove_project_setting"]:
        if not exists:
            fail("Configuration entry is not stored in project.godot")
            return
        result({"expression": null, "removed": true, "defaultsMayApply": true})
        return
    elif operation == "set_input_action":
        var old = config.get_value(section, key, {})
        if not old is Dictionary:
            fail("Existing input action is not a dictionary")
            return
        var events = []
        for spec in params.events:
            var made = make_event(spec)
            if not made.ok:
                fail(made.error)
                return
            events.append(made.value)
        value = old.duplicate(true)
        value.deadzone = params.get("deadzone", old.get("deadzone", 0.5))
        value.events = events
    elif operation == "set_project_setting":
        var converted = pure_value(params.value)
        if not converted.ok:
            fail(converted.error)
            return
        value = converted.value
        var setting = section + "/" + key
        var expected_type = -1
        for info in ProjectSettings.get_property_list():
            if str(info.name) == setting or (expected_type == -1 and "." in key and str(info.name) == setting.get_slice(".", 0)):
                expected_type = info.type
                break
        if expected_type == -1 and exists: expected_type = typeof(config.get_value(section, key))
        if expected_type == TYPE_FLOAT and value is int: value = float(value)
        if expected_type == TYPE_PACKED_STRING_ARRAY and value is Array:
            for item in value:
                if not item is String:
                    fail("PackedStringArray setting requires strings")
                    return
            value = PackedStringArray(value)
        if expected_type != -1 and typeof(value) != expected_type:
            fail("Setting type mismatch: expected " + type_string(expected_type))
            return
    else:
        fail("Unknown configuration operation")
        return
    var expression = var_to_str(value)
    result({"expression": expression, "configuredOnly": true, "resourceValidation": "path-only" if operation == "register_autoload" else null})

func result(data):
    var text = JSON.stringify(data)
    if text.to_utf8_buffer().size() > 60000:
        fail("Configuration response exceeds 60 KiB; reduce action/event limits")
        return
    print("GODOT_MCP_RESULT " + text)
    quit(0)
