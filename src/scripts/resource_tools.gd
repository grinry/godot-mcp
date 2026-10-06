extends SceneTree
const Safety = preload("scene_safety.gd")
const Codec = preload("variant_codec.gd")

func fail(message):
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
    var operation = args[0]
    var resource = null
    if operation == "create_resource":
        if not ClassDB.class_exists(params.className) or not ClassDB.can_instantiate(params.className) or not ClassDB.is_parent_class(params.className, "Resource") or ClassDB.is_parent_class(params.className, "Script") or params.className == "PackedScene":
            fail("Expected an instantiable built-in Resource class, excluding scripts and PackedScene")
            return
        resource = ClassDB.instantiate(params.className)
    else:
        var error = Safety.validate_dependencies(params.resourcePath)
        if error != "":
            fail(error)
            return
        resource = ResourceLoader.load(params.resourcePath, "", ResourceLoader.CACHE_MODE_IGNORE)
    if not resource is Resource or resource is Script or resource is PackedScene:
        fail("Expected a .tres/.res resource, excluding scripts and scenes")
        return
    if operation == "get_resource_info":
        var limits = Codec.budget()
        var properties = []
        var truncated = false
        for info in resource.get_property_list():
            if not (info.usage & PROPERTY_USAGE_STORAGE):
                continue
            if properties.size() >= params.maxProperties:
                truncated = true
                break
            properties.append({"name": str(info.name), "type": type_string(info.type), "value": Codec.encode(resource.get(info.name), 0, limits)})
        result({"className": resource.get_class(), "properties": properties, "truncated": truncated})
        return
    if operation not in ["create_resource", "set_resource_properties"]:
        fail("Unknown resource operation")
        return
    var original_script = resource.get_script()
    for key in params.properties:
        if key in ["script", "resource_path"] or str(key).begins_with("metadata/"):
            fail("Script/path/metadata properties require dedicated tools")
            return
        var info = null
        for property in resource.get_property_list():
            if property.name == key and property.usage & PROPERTY_USAGE_STORAGE and not (property.usage & PROPERTY_USAGE_READ_ONLY):
                info = property
                break
        if info == null:
            fail("Unknown or non-stored property: " + key)
            return
        var converted = Codec.decode(params.properties[key], info)
        if not converted.ok:
            fail(key + ": " + converted.error)
            return
        resource.set(key, converted.value)
        if resource.get(key) != converted.value:
            fail("Property setter rejected value: " + key)
            return
    var error = ResourceSaver.save(resource, params.outputPath)
    if error != OK:
        fail("Cannot save temporary resource: " + str(error))
        return
    if operation != "create_resource":
        var uid = ResourceLoader.get_resource_uid(params.resourcePath)
        if uid != -1 and ResourceSaver.set_uid(params.outputPath, uid) != OK:
            fail("Cannot preserve resource UID")
            return
    var reloaded = ResourceLoader.load(params.outputPath, "", ResourceLoader.CACHE_MODE_IGNORE)
    if not reloaded is Resource or reloaded.get_script() != original_script:
        fail("Cannot reload resource while preserving its script")
        return
    for key in params.properties:
        if reloaded.get(key) != resource.get(key):
            fail("Saving would lose property: " + key)
            return
    result({"className": resource.get_class(), "success": true})

func result(data):
    var text = JSON.stringify(data)
    if text.to_utf8_buffer().size() > 60000:
        fail("Resource response exceeds 60 KiB; reduce maxProperties")
        return
    print("GODOT_MCP_RESULT " + text)
    quit(0)
