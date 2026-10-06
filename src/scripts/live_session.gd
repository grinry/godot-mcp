# Temporary debug session; no addon installation, autoload override or socket listener.
extends SceneTree
const Codec = preload("variant_codec.gd")

var directory = ""
var token = ""
var busy = false
var queued_input = []

func _initialize():
    call_deferred("start_session")

func write_json(path, data):
    var file = FileAccess.open(path + ".tmp", FileAccess.WRITE)
    if file == null:
        quit(1)
        return
    file.store_string(JSON.stringify(data))
    file.close()
    if DirAccess.rename_absolute(path + ".tmp", path) != OK:
        quit(1)

func start_session():
    var args = OS.get_cmdline_user_args()
    if args.size() != 1:
        quit(1)
        return
    directory = args[0].get_base_dir()
    var config = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
    if not config is Dictionary or not config.get("token") is String:
        quit(1)
        return
    token = config.token
    var scene_path = config.get("scene", "")
    if scene_path == "":
        scene_path = ProjectSettings.get_setting("application/run/main_scene", "")
    var packed = load(scene_path) if scene_path != "" else null
    if not packed is PackedScene:
        write_json(directory.path_join("ready.json"), {"ok": false, "error": "Configure a main scene or supply scenePath"})
        return
    var scene = packed.instantiate()
    root.add_child(scene)
    current_scene = scene
    process_frame.connect(poll_request)
    write_json(directory.path_join("ready.json"), {"ok": true, "scene": scene_path})

func poll_request():
    if busy:
        return
    var path = directory.path_join("request.json")
    if not FileAccess.file_exists(path):
        return
    var file = FileAccess.open(path, FileAccess.READ)
    if file == null:
        return
    if file.get_length() > 65536:
        file.close()
        DirAccess.remove_absolute(path)
        return
    var request = JSON.parse_string(file.get_as_text())
    file.close()
    DirAccess.remove_absolute(path)
    if not request is Dictionary or request.get("token") != token:
        return
    var id = request.get("id", "")
    if not id is String or id.length() != 36 or id.validate_filename() != id:
        return
    var params = request.get("params", {})
    if not params is Dictionary:
        return
    busy = true
    handle_request(id, request.get("operation", ""), params)

func reply(id, ok, error = "", extra = {}):
    var response = {"id": id, "ok": ok}
    response.merge(extra)
    if error != "":
        response.error = error
    if JSON.stringify(response).to_utf8_buffer().size() > 60000:
        response = {"id": id, "ok": false, "error": "Response exceeds 60 KiB; request fewer properties"}
    write_json(directory.path_join("response-" + id + ".json"), response)
    busy = false

func advance_paused(count, kind):
    # Each requested boundary is counted after the corresponding node callbacks.
    if kind == "physics": await physics_frame
    else: await process_frame
    paused = false
    for event in queued_input: Input.parse_input_event(event)
    queued_input.clear()
    Input.flush_buffered_events()
    for index in count:
        if kind == "physics": await physics_frame
        else: await process_frame
    paused = true

func performance_snapshot():
    var definitions = [
        ["fps", Performance.TIME_FPS, "frames/s", 1.0, false],
        ["processTime", Performance.TIME_PROCESS, "ms", 1000.0, false],
        ["physicsTime", Performance.TIME_PHYSICS_PROCESS, "ms", 1000.0, false],
        ["staticMemory", Performance.MEMORY_STATIC, "bytes", 1.0, false],
        ["nodeCount", Performance.OBJECT_NODE_COUNT, "count", 1.0, false],
        ["objectCount", Performance.OBJECT_COUNT, "count", 1.0, false],
        ["resourceCount", Performance.OBJECT_RESOURCE_COUNT, "count", 1.0, false],
        ["orphanNodeCount", Performance.OBJECT_ORPHAN_NODE_COUNT, "count", 1.0, false],
        ["drawCalls", Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME, "count", 1.0, true],
        ["renderedObjects", Performance.RENDER_TOTAL_OBJECTS_IN_FRAME, "count", 1.0, true],
        ["videoMemory", Performance.RENDER_VIDEO_MEM_USED, "bytes", 1.0, true],
        ["textureMemory", Performance.RENDER_TEXTURE_MEM_USED, "bytes", 1.0, true],
        ["physics2dObjects", Performance.PHYSICS_2D_ACTIVE_OBJECTS, "count", 1.0, false],
        ["physics3dObjects", Performance.PHYSICS_3D_ACTIVE_OBJECTS, "count", 1.0, false],
    ]
    var monitors = []
    for definition in definitions:
        var available = not (definition[4] and DisplayServer.get_name() == "headless")
        var value = Performance.get_monitor(definition[1]) * definition[3] if available else null
        monitors.append({"name": definition[0], "value": value, "unit": definition[2], "available": available})
    return {"monitors": monitors, "sampledAtMs": Time.get_ticks_msec(), "paused": paused}

func incomplete(value):
    if value is Dictionary:
        if value.get("truncated", false) == true or value.get("unsupported", false) == true: return true
        for child in value.values():
            if incomplete(child): return true
    elif value is Array:
        for child in value:
            if incomplete(child): return true
    return false

func sample_properties(params):
    if not is_instance_valid(current_scene): return {"ok": false, "error": "No current scene"}
    var path = params.nodePath
    if path == "root": path = "."
    elif path.begins_with("root/"): path = path.trim_prefix("root/")
    var node = current_scene.get_node_or_null(NodePath(path))
    if node == null: return {"ok": false, "error": "Runtime node not found"}
    var available = {}
    for info in node.get_property_list(): available[str(info.name)] = true
    var values = {}
    var limits = Codec.budget()
    for property in params.properties:
        if not available.has(property): return {"ok": false, "error": "Unknown property: " + property}
    for property in params.properties:
        var value = Codec.encode(node.get(property), 0, limits)
        if incomplete(value): return {"ok": false, "error": "Cannot sample truncated or unsupported property: " + property}
        values[property] = value
    return {"ok": true, "values": values}

func sample_runtime(id, params):
    if not paused:
        reply(id, false, "Pause the debug session before sampling")
        return
    var count = int(params.samples)
    var interval = int(params.intervalFrames)
    if count < 2 or count > 120 or interval < 1 or interval > 120 or (count - 1) * interval > 1200 or params.kind not in ["physics", "process"]:
        reply(id, false, "Invalid sampling limits")
        return
    var samples = []
    var metrics = []
    var bytes = 0
    for index in count:
        if index > 0: await advance_paused(interval, params.kind)
        var values = {}
        if params.source == "properties":
            var reading = sample_properties(params)
            if not reading.ok:
                reply(id, false, reading.error)
                return
            values = reading.values
        else:
            var reading = performance_snapshot()
            for monitor in reading.monitors:
                if monitor.name in params.monitors:
                    values[monitor.name] = monitor.value
                    if index == 0: metrics.append({"name": monitor.name, "unit": monitor.unit, "available": monitor.available})
        var sample = {"sampledAtMs": Time.get_ticks_msec(), "processFrame": Engine.get_process_frames(), "physicsFrame": Engine.get_physics_frames(), "values": values}
        bytes += JSON.stringify(sample).to_utf8_buffer().size()
        if bytes > 40000:
            reply(id, false, "Sample evidence exceeds 40 KiB; reduce samples/fields")
            return
        samples.append(sample)
    reply(id, true, "", {"samples": samples, "metrics": metrics, "sampleCount": count, "kind": params.kind, "intervalFrames": interval, "advancedFrames": (count - 1) * interval, "paused": true})

func handle_request(id, operation, params):
    match operation:
        "screenshot":
            if DisplayServer.get_name() == "headless":
                reply(id, false, "A display renderer is required for screenshots")
                return
            await RenderingServer.frame_post_draw
            var image = root.get_texture().get_image()
            if image == null or image.is_empty():
                reply(id, false, "Viewport produced no image")
                return
            var error = image.save_png(directory.path_join("capture-" + id + ".png"))
            reply(id, error == OK, "" if error == OK else "Failed to save screenshot", {"width": image.get_width(), "height": image.get_height(), "paused": paused})
        "tree":
            var max_depth = int(params.get("maxDepth", 10))
            var max_nodes = int(params.get("maxNodes", 100))
            if max_depth < 0 or max_depth > 20 or max_nodes < 1 or max_nodes > 200:
                reply(id, false, "Invalid runtime tree limits")
                return
            if not is_instance_valid(current_scene):
                reply(id, false, "No current scene")
                return
            var queue = [{"node": current_scene, "depth": 0}]
            var nodes = []
            var truncated = false
            var index = 0
            var bytes = 0
            while index < queue.size() and nodes.size() < max_nodes:
                var item = queue[index]
                index += 1
                var node = item.node
                var script = node.get_script()
                var entry = {"path": str(current_scene.get_path_to(node)).left(1024), "class": node.get_class(), "scriptPath": script.resource_path.left(1024) if script != null else "", "depth": item.depth}
                bytes += JSON.stringify(entry).to_utf8_buffer().size()
                if bytes > 50000:
                    truncated = true
                    break
                nodes.append(entry)
                var children = node.get_children()
                if item.depth >= max_depth:
                    truncated = truncated or not children.is_empty()
                    continue
                for child in children:
                    if queue.size() >= max_nodes:
                        truncated = true
                        break
                    queue.append({"node": child, "depth": item.depth + 1})
            truncated = truncated or index < queue.size()
            reply(id, true, "", {"nodes": nodes, "truncated": truncated, "paused": paused})
        "properties":
            if not is_instance_valid(current_scene):
                reply(id, false, "No current scene")
                return
            var path = params.get("nodePath", ".")
            if path == "root":
                path = "."
            elif path.begins_with("root/"):
                path = path.trim_prefix("root/")
            var node = current_scene.get_node_or_null(NodePath(path))
            if node == null:
                reply(id, false, "Runtime node not found")
                return
            var limits = Codec.budget()
            var values = {}
            var available = {}
            for info in node.get_property_list():
                available[str(info.name)] = info
            for key in params.get("properties", []):
                if not available.has(key):
                    reply(id, false, "Unknown property: " + str(key))
                    return
                values[key] = {"type": type_string(available[key].type), "value": Codec.encode(node.get(key), 0, limits)}
            reply(id, true, "", {"nodePath": path, "properties": values, "paused": paused})
        "step":
            if not paused:
                reply(id, false, "Pause the debug session before stepping")
                return
            var count = int(params.get("frames", 0))
            var kind = params.get("kind", "physics")
            if count < 1 or count > 120 or kind not in ["physics", "process"]:
                reply(id, false, "Invalid frame step")
                return
            await advance_paused(count, kind)
            reply(id, true, "", {"frames": count, "kind": kind, "paused": true})
        "pause":
            if not params.get("paused") is bool:
                reply(id, false, "paused must be boolean")
                return
            paused = params.paused
            reply(id, true, "", {"paused": paused})
        "input":
            var event = null
            match params.get("kind", ""):
                "action":
                    if not params.get("action") is String or not InputMap.has_action(params.action):
                        reply(id, false, "Unknown input action")
                        return
                    event = InputEventAction.new()
                    event.action = params.action
                    event.pressed = params.get("pressed", true)
                    event.strength = params.get("strength", 1.0)
                "key":
                    event = InputEventKey.new()
                    event.keycode = int(params.get("keycode", 0))
                    event.pressed = params.get("pressed", true)
                "mouse_button":
                    event = InputEventMouseButton.new()
                    event.button_index = int(params.get("button", 1))
                    event.position = Vector2(params.get("x", 0), params.get("y", 0))
                    event.pressed = params.get("pressed", true)
                "mouse_motion":
                    event = InputEventMouseMotion.new()
                    event.position = Vector2(params.get("x", 0), params.get("y", 0))
                    event.relative = event.position - root.get_mouse_position()
                _:
                    reply(id, false, "Unknown input kind")
                    return
            if params.get("atNextFrame", false):
                if not paused or queued_input.size() >= 100:
                    reply(id, false, "Queued input requires a paused session and at most 100 events")
                    return
                queued_input.append(event)
                reply(id, true, "", {"queued": true})
            else:
                Input.parse_input_event(event)
                reply(id, true)
        "performance":
            reply(id, true, "", performance_snapshot())
        "sample": await sample_runtime(id, params)
        _:
            reply(id, false, "Unknown debug operation")
