extends RefCounted

# Validate dependencies before a lossy load/instantiate/repack. In particular a
# non-.NET executable must never replace C# script references with null.
static func validate_dependencies(path, seen = {}):
    if seen.has(path):
        return ""
    if seen.size() >= 4096:
        return "Scene dependency limit exceeded"
    seen[path] = true
    for dependency in ResourceLoader.get_dependencies(path):
        var fields = dependency.split("::")
        var resource_path = fields[fields.size() - 1]
        if not resource_path.begins_with("res://") and fields[0].begins_with("uid://"):
            var uid = ResourceUID.text_to_id(fields[0])
            if ResourceUID.has_id(uid):
                resource_path = ResourceUID.get_id_path(uid)
        if not resource_path.begins_with("res://"):
            return "Cannot resolve scene dependency: " + dependency
        if resource_path.get_extension().to_lower() in ["gd", "cs"]:
            if resource_path.get_extension().to_lower() == "cs" and not ClassDB.class_exists("CSharpScript"):
                return "C# scene edits require the Godot .NET executable and a built, loadable assembly: " + resource_path
            var script = ResourceLoader.load(resource_path)
            if not script is Script or not script.can_instantiate():
                return "Script dependency cannot be instantiated; refusing to save: " + resource_path
        var error = validate_dependencies(resource_path, seen)
        if error != "":
            return error
    return ""

static func validate_state(state):
    if state == null:
        return ""
    var inherited_error = validate_state(state.get_base_scene_state())
    if inherited_error != "":
        return inherited_error
    for index in state.get_node_count():
        var instance = state.get_node_instance(index)
        if instance != null:
            var error = validate_state(instance.get_state())
            if error != "":
                return error
        for property in state.get_node_property_count(index):
            if state.get_node_property_name(index, property) == "script":
                var script = state.get_node_property_value(index, property)
                if not script is Script or not script.can_instantiate():
                    return "Scene contains an unavailable script; refusing to save"
    return ""

static func load_scene(path):
    var error = validate_dependencies(path)
    if error != "":
        return {"ok": false, "error": error}
    var scene = ResourceLoader.load(path)
    if not scene is PackedScene:
        return {"ok": false, "error": "Cannot load PackedScene: " + path}
    error = validate_state(scene.get_state())
    if error != "":
        return {"ok": false, "error": error}
    return {"ok": true, "scene": scene}

static func script_references(node, references = {}, path = "."):
    var script = node.get_script()
    if script != null:
        references[path] = script
    for child in node.get_children():
        script_references(child, references, str(node.get_path_to(child)) if path == "." else path.path_join(str(child.name)))
    return references

static func pack_preserving_scripts(root, references):
    for path in references:
        var node = root.get_node_or_null(NodePath(path))
        if node == null or node.get_script() != references[path]:
            return {"ok": false, "error": "Script reference changed unexpectedly: " + path}
    var packed = PackedScene.new()
    var error = packed.pack(root)
    if error != OK:
        return {"ok": false, "error": "Cannot pack scene: " + str(error)}
    # Verify the serialized resource, not merely the in-memory tree.
    var reloaded = packed.instantiate()
    for path in references:
        var node = reloaded.get_node_or_null(NodePath(path))
        if node == null or node.get_script() != references[path]:
            reloaded.free()
            return {"ok": false, "error": "Packing would lose a script reference: " + path}
    reloaded.free()
    return {"ok": true, "scene": packed}
