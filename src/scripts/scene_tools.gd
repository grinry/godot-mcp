extends SceneTree
const Safety = preload("scene_safety.gd")
const Codec = preload("variant_codec.gd")
var scene_root

func fail(message):
    if is_instance_valid(scene_root):
        scene_root.free()
    printerr(message)
    quit(1)

func _init():
    var args = OS.get_cmdline_user_args()
    if args.size() != 2:
        fail("Expected operation and JSON")
        return
    var params = JSON.parse_string(args[1])
    if not params is Dictionary:
        fail("Expected JSON object")
        return
    var checked = Safety.load_scene(params.scenePath)
    if not checked.ok:
        fail(checked.error)
        return
    if args[0] == "inspect":
        inspect_scene(checked.scene, params)
    elif args[0] == "modify":
        modify_scene(checked.scene, params)
    else:
        fail("Unknown scene operation")

func result(data):
    var text = JSON.stringify(data)
    if text.to_utf8_buffer().size() > 1000000:
        fail("Scene result exceeds 1 MiB; reduce limits")
        return
    print("GODOT_MCP_RESULT " + text)
    quit(0)

func inspect_scene(scene, params):
    var limits = Codec.budget()
    var state = scene.get_state()
    var nodes = []
    var connections = []
    var truncated = false
    for index in mini(state.get_node_count(), params.maxNodes):
        var properties = []
        var script = null
        for property in state.get_node_property_count(index):
            var name_of_property = str(state.get_node_property_name(index, property))
            var value = state.get_node_property_value(index, property)
            if name_of_property == "script" and value is Script:
                script = value
            if properties.size() < params.maxProperties:
                properties.append({"name": name_of_property, "value": Codec.encode(value, 0, limits)})
        var exports = []
        var exports_truncated = false
        if script != null:
            for info in script.get_script_property_list():
                if info.usage & PROPERTY_USAGE_EDITOR and info.usage & PROPERTY_USAGE_SCRIPT_VARIABLE:
                    if exports.size() >= params.maxProperties:
                        exports_truncated = true
                        break
                    exports.append({"name": str(info.name), "type": type_string(info.type), "hint": info.hint, "hintString": info.hint_string, "default": Codec.encode(script.get_property_default_value(info.name), 0, limits)})
        var instance = state.get_node_instance(index)
        nodes.append({"path": str(state.get_node_path(index)).trim_prefix("./"), "name": str(state.get_node_name(index)), "class": str(state.get_node_type(index)), "instancePath": instance.resource_path if instance != null else "", "groups": Array(state.get_node_groups(index)), "scriptPath": script.resource_path if script != null else "", "exportedProperties": exports, "exportsTruncated": exports_truncated, "ownerPath": str(state.get_node_owner_path(index)), "properties": properties, "propertiesTruncated": state.get_node_property_count(index) > params.maxProperties})
    for index in mini(state.get_connection_count(), 500):
        connections.append({"source": str(state.get_connection_source(index)), "signal": str(state.get_connection_signal(index)), "target": str(state.get_connection_target(index)), "method": str(state.get_connection_method(index)), "flags": state.get_connection_flags(index), "binds": Codec.encode(state.get_connection_binds(index), 0, limits), "unbinds": state.get_connection_unbinds(index)})
    var dependencies = ResourceLoader.get_dependencies(params.scenePath)
    truncated = state.get_node_count() > params.maxNodes or state.get_connection_count() > 500 or dependencies.size() > 500
    var base = state.get_base_scene_state()
    result({"nodes": nodes, "connections": connections, "dependencies": Array(dependencies).slice(0, 500), "baseScene": base.get_path() if base != null else "", "serializedOnly": true, "truncated": truncated})

func find_node(path):
    if path == "root" or path == ".":
        return scene_root
    if path.begins_with("root/"):
        path = path.trim_prefix("root/")
    return scene_root.get_node_or_null(NodePath(path))

func local_node(node):
    if node == scene_root:
        return true
    if node.owner != scene_root:
        return false
    var ancestor = node
    while ancestor != scene_root:
        if ancestor.scene_file_path != "":
            return false
        ancestor = ancestor.get_parent()
    return true

func all_nodes():
    var nodes = [scene_root]
    var index = 0
    while index < nodes.size():
        if nodes.size() > 2000:
            return []
        nodes.append_array(nodes[index].get_children())
        index += 1
    return nodes

# Snapshot actual targets before moving a node, then recompute relative paths.
# Refuse unresolved NodePaths and nested reference collections: guessing is lossy.
func references(nodes):
    var paths = []
    var links = []
    for node in nodes:
        for info in node.get_property_list():
            if not (info.usage & PROPERTY_USAGE_STORAGE) or info.name == "script":
                continue
            var value = node.get(info.name)
            if value is NodePath and not value.is_empty():
                if value.is_absolute():
                    return {"ok": false, "error": "Structural edits refuse absolute NodePaths"}
                var names = str(value.get_concatenated_names())
                var target = node if names == "" else node.get_node_or_null(NodePath(names))
                if target == null:
                    return {"ok": false, "error": "Structural edits refuse unresolved NodePath: " + str(info.name)}
                paths.append({"node": node, "property": info.name, "target": target, "subnames": str(value.get_concatenated_subnames())})
            elif value is Node:
                links.append({"node": node, "target": value})
            elif value is Resource:
                return {"ok": false, "error": "Structural edits refuse embedded resource references; edit properties separately"}
            elif value is Array or value is Dictionary:
                if contains_reference(value):
                    return {"ok": false, "error": "Structural edits refuse references nested in collections"}
        for signal_info in node.get_signal_list():
            for connection in node.get_signal_connection_list(signal_info.name):
                if connection.flags & CONNECT_PERSIST:
                    links.append({"node": node, "target": connection.callable.get_object()})
                    if contains_reference(connection.callable.get_bound_arguments()):
                        return {"ok": false, "error": "Structural edits refuse bound node references"}
    return {"ok": true, "paths": paths, "links": links}

func contains_reference(value, depth = 0):
    if depth > 16:
        return true
    if value is Node or value is NodePath or value is Resource:
        return true
    if value is Array:
        for child in value:
            if contains_reference(child, depth + 1):
                return true
    elif value is Dictionary:
        for key in value:
            if contains_reference(key, depth + 1) or contains_reference(value[key], depth + 1):
                return true
    return false

func inside(node, ancestor):
    return node == ancestor or ancestor.is_ancestor_of(node)

func compatible_argument(source, target):
    if target.type == TYPE_NIL:
        return true
    if source.type != target.type:
        return source.type in [TYPE_INT, TYPE_FLOAT] and target.type in [TYPE_INT, TYPE_FLOAT]
    if source.type == TYPE_OBJECT:
        var source_class = str(source.get("class_name", ""))
        var target_class = str(target.get("class_name", ""))
        if target_class == "" or target_class == "Object" or source_class == target_class:
            return true
        if ClassDB.class_exists(source_class) and ClassDB.class_exists(target_class):
            return ClassDB.is_parent_class(source_class, target_class)
        for entry in ProjectSettings.get_global_class_list():
            if entry.get("class") != source_class:
                continue
            var script = load(entry.path)
            while script is Script:
                if script.get_global_name() == target_class:
                    return true
                if ClassDB.class_exists(target_class) and ClassDB.is_parent_class(script.get_instance_base_type(), target_class):
                    return true
                script = script.get_base_script()
        return false
    return true

func apply_operation(operation, nodes):
    var node = find_node(operation.nodePath)
    if node == null or not local_node(node):
        return "Node is missing or belongs to an instanced scene"
    match operation.op:
        "set_properties":
            for key in operation.properties:
                if key in ["script", "owner", "name", "scene_file_path", "unique_name_in_owner"] or str(key).begins_with("metadata/"):
                    return "Use dedicated operations for structural/script properties"
                var info = null
                for property in node.get_property_list():
                    if property.name == key and property.usage & PROPERTY_USAGE_STORAGE and not (property.usage & PROPERTY_USAGE_READ_ONLY):
                        info = property
                        break
                if info == null:
                    return "Unknown or non-stored property: " + key
                var converted = Codec.decode(operation.properties[key], info)
                if not converted.ok:
                    return key + ": " + converted.error
                if converted.value is NodePath and not converted.value.is_empty():
                    var target = node.get_node_or_null(NodePath(str(converted.value.get_concatenated_names())))
                    if converted.value.is_absolute() or target == null:
                        return "NodePath must resolve inside the scene"
                node.set(key, converted.value)
                if node.get(key) != converted.value:
                    return "Property setter rejected value: " + key
        "add_group": node.add_to_group(operation.group, true)
        "remove_group": node.remove_from_group(operation.group)
        "connect_signal", "disconnect_signal":
            var target = find_node(operation.targetNodePath)
            if target == null or not local_node(target) or not node.has_signal(operation.signal) or not target.has_method(operation.method):
                return "Signal, target or method unavailable"
            if operation.op == "connect_signal":
                var signal_arguments = []
                for info in node.get_signal_list():
                    if info.name == operation.signal:
                        signal_arguments = info.args
                for info in target.get_method_list():
                    if info.name == operation.method:
                        if signal_arguments.size() < info.args.size() - info.default_args.size() or (not (info.flags & METHOD_FLAG_VARARG) and signal_arguments.size() > info.args.size()):
                            return "Signal arguments are incompatible with target method"
                        for index in mini(signal_arguments.size(), info.args.size()):
                            if not compatible_argument(signal_arguments[index], info.args[index]):
                                return "Signal argument types are incompatible with target method"
            var callback = Callable(target, operation.method)
            if operation.op == "connect_signal":
                if not node.is_connected(operation.signal, callback):
                    if node.connect(operation.signal, callback, CONNECT_PERSIST) != OK:
                        return "Cannot connect signal"
            elif node.is_connected(operation.signal, callback):
                node.disconnect(operation.signal, callback)
        "remove_node", "rename_node", "reparent_node":
            if node == scene_root:
                return "Structural edits cannot change the scene root"
            var refs = references(nodes)
            if not refs.ok:
                return refs.error
            if operation.op == "remove_node":
                for reference in refs.paths + refs.links:
                    if is_instance_valid(reference.target) and reference.target is Node and inside(reference.target, node) and not inside(reference.node, node):
                        return "Cannot remove a referenced node; remove references/connections first"
                node.get_parent().remove_child(node)
                node.free()
            else:
                if operation.op == "rename_node":
                    if node.get_parent().get_node_or_null(NodePath(operation.newName)) != null and str(node.name) != operation.newName:
                        return "Sibling name already exists"
                    node.name = operation.newName
                else:
                    var parent = find_node(operation.parentNodePath)
                    if parent == null or not local_node(parent) or inside(parent, node):
                        return "Invalid reparent destination"
                    var sibling = parent.get_node_or_null(NodePath(str(node.name)))
                    if sibling != null and sibling != node:
                        return "Destination has a node with this name"
                    node.reparent(parent, true)
                    node.owner = scene_root
                for reference in refs.paths:
                    var path = str(reference.node.get_path_to(reference.target))
                    if reference.subnames != "":
                        path += ":" + reference.subnames
                    reference.node.set(reference.property, NodePath(path))
                    if reference.node.get(reference.property) != NodePath(path):
                        return "Cannot preserve NodePath after structural edit"
        _: return "Unknown operation"
    return ""

func modify_scene(scene, params):
    if scene.get_state().get_base_scene_state() != null:
        fail("Inherited scenes are not supported by transactional edits")
        return
    scene_root = scene.instantiate()
    var original_scripts = []
    for node in all_nodes():
        if node.get_script() != null:
            original_scripts.append({"node": node, "script": node.get_script()})
    var changes = []
    for operation in params.operations:
        var nodes = all_nodes()
        if nodes.is_empty():
            fail("Scene exceeds 2000 nodes")
            return
        var error = apply_operation(operation, nodes)
        if error != "":
            fail("Operation " + str(changes.size()) + ": " + error)
            return
        changes.append(operation)
    for reference in original_scripts:
        if is_instance_valid(reference.node) and reference.node.get_script() != reference.script:
            fail("Operation unexpectedly changed a script reference")
            return
    var scripts = Safety.script_references(scene_root)
    var packed = Safety.pack_preserving_scripts(scene_root, scripts)
    if not packed.ok:
        fail(packed.error)
        return
    # Keep the original scene UID when replacing a temporary file.
    var uid = ResourceLoader.get_resource_uid(params.scenePath)
    var error = ResourceSaver.save(packed.scene, params.outputPath)
    if error != OK:
        fail("Cannot save temporary scene: " + str(error))
        return
    if uid != -1:
        ResourceSaver.set_uid(params.outputPath, uid)
    var saved = ResourceLoader.load(params.outputPath, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
    if not saved is PackedScene:
        fail("Cannot reload edited scene")
        return
    scene_root.free()
    scene_root = null
    result({"success": true, "operations": changes})
