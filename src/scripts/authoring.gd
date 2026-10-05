extends SceneTree
const SceneSafety = preload("scene_safety.gd")

func fail(message):
    printerr(message)
    quit(1)

func _init():
    var args = OS.get_cmdline_user_args()
    if args.size() != 2:
        fail("Expected operation and parameters")
        return
    var operation = args[0]
    var params = JSON.parse_string(args[1])
    if not params is Dictionary:
        fail("Expected JSON object")
        return
    if operation == "get_class_info":
        class_info(params)
        return
    var checked = SceneSafety.load_scene(params.scenePath)
    if not checked.ok:
        fail(checked.error)
        return
    var root_node = checked.scene.instantiate()
    var scripts = SceneSafety.script_references(root_node)
    var node = find_node(root_node, params.nodePath)
    if node == null:
        root_node.free()
        fail("Node not found in scene")
        return
    if operation == "attach_script":
        var extension = params.scriptPath.get_extension().to_lower()
        if extension == "cs" and not ClassDB.class_exists("CSharpScript"):
            root_node.free()
            fail("C# attachment requires the Godot .NET executable and a built, loadable assembly")
            return
        var script = load(params.scriptPath)
        if not script is Script or not script.can_instantiate():
            root_node.free()
            fail("Script cannot be instantiated; build/import the project first")
            return
        if not node.is_class(script.get_instance_base_type()):
            root_node.free()
            fail("Script base type is incompatible with the node")
            return
        node.set_script(script)
        if node.get_script() != script:
            root_node.free()
            fail("Script attachment failed")
            return
        # Only this deliberate script replacement may change the snapshot.
        scripts[str(root_node.get_path_to(node))] = script
    elif operation == "set_node_reference":
        var target = find_node(root_node, params.targetNodePath)
        if target == null:
            root_node.free()
            fail("Target node not found in scene")
            return
        var info = null
        for property in node.get_property_list():
            if property.name == params.property:
                info = property
                break
        if info == null or not (info.usage & PROPERTY_USAGE_EDITOR) or not (info.usage & PROPERTY_USAGE_SCRIPT_VARIABLE):
            root_node.free()
            fail("Property must be an exported script Node or NodePath reference")
            return
        if info.type == TYPE_NODE_PATH:
            node.set(params.property, node.get_path_to(target))
        elif info.type == TYPE_OBJECT and info.hint == PROPERTY_HINT_NODE_TYPE:
            if info.hint_string != "" and not matches_type(target, info.hint_string):
                root_node.free()
                fail("Target node type is incompatible with exported property")
                return
            node.set(params.property, target)
        else:
            root_node.free()
            fail("Property must be an exported Node or NodePath reference")
            return
        var value = node.get(params.property)
        if (info.type == TYPE_OBJECT and value != target) or (info.type == TYPE_NODE_PATH and value != node.get_path_to(target)):
            root_node.free()
            fail("Node reference assignment failed")
            return
    else:
        root_node.free()
        fail("Unknown authoring operation")
        return
    var packed = SceneSafety.pack_preserving_scripts(root_node, scripts)
    root_node.free()
    if not packed.ok:
        fail(packed.error)
        return
    var error = ResourceSaver.save(packed.scene, params.scenePath)
    if error != OK:
        fail("Cannot save scene: " + str(error))
        return
    print("GODOT_MCP_RESULT " + JSON.stringify({"success": true, "scenePath": params.scenePath}))
    quit(0)

func find_node(scene_root, path):
    if path == "root" or path == ".":
        return scene_root
    if path.begins_with("root/"):
        path = path.trim_prefix("root/")
    if path.begins_with("/") or path.split("/").has("..") or path.contains(":"):
        return null
    return scene_root.get_node_or_null(NodePath(path))

func matches_type(node, type_name):
    if node.is_class(type_name):
        return true
    var script = node.get_script()
    while script != null:
        if script.get_global_name() == type_name:
            return true
        script = script.get_base_script()
    return false

func class_info(params):
    var name_of_class = params.className
    if not ClassDB.class_exists(name_of_class):
        fail("Unknown built-in Godot class")
        return
    var section = params.get("section", "properties")
    var own_only = not params.get("includeInherited", true)
    var entries = []
    match section:
        "properties": entries = ClassDB.class_get_property_list(name_of_class, own_only)
        "methods": entries = ClassDB.class_get_method_list(name_of_class, own_only)
        "signals": entries = ClassDB.class_get_signal_list(name_of_class, own_only)
        "enums":
            for name_of_enum in ClassDB.class_get_enum_list(name_of_class, own_only):
                var values = {}
                for constant in ClassDB.class_get_enum_constants(name_of_class, name_of_enum, own_only):
                    values[constant] = ClassDB.class_get_integer_constant(name_of_class, constant)
                entries.append({"name": name_of_enum, "values": values})
        _:
            fail("Unknown ClassDB section")
            return
    var filtered = []
    for entry in entries:
        if params.get("filter", "") == "" or str(entry.name).to_lower().contains(params.filter.to_lower()):
            filtered.append(entry)
    var limit = int(params.get("limit", 100))
    print("GODOT_MCP_RESULT " + JSON.stringify({"className": name_of_class, "parentClass": ClassDB.get_parent_class(name_of_class), "godotVersion": Engine.get_version_info().string, "section": section, "entries": filtered.slice(0, limit), "truncated": filtered.size() > limit}))
    quit(0)
