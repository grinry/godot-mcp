extends RefCounted

# Explicit type tags avoid guessing whether an array is a Vector, Color or collection.
static func budget():
    return {"remaining": 1000, "characters": 40000}

static func encode(value, depth = 0, limits = null):
    if limits == null:
        limits = budget()
    if depth > 6 or limits.remaining <= 0:
        return {"type": type_string(typeof(value)), "truncated": true}
    limits.remaining -= 1
    match typeof(value):
        TYPE_NIL, TYPE_BOOL, TYPE_INT: return value
        TYPE_STRING, TYPE_STRING_NAME:
            var text = str(value)
            var size = mini(4096, limits.characters)
            limits.characters -= mini(text.length(), size)
            if text.length() > size:
                return {"type": type_string(typeof(value)), "value": text.left(size), "truncated": true}
            return text
        TYPE_FLOAT: return value if is_finite(value) else {"type": "float", "value": str(value).left(4096), "truncated": str(value).length() > 4096}
        TYPE_NODE_PATH: return {"type": "NodePath", "value": str(value).left(4096), "truncated": str(value).length() > 4096}
        TYPE_VECTOR2, TYPE_VECTOR2I: return {"type": type_string(typeof(value)), "value": [value.x, value.y]}
        TYPE_VECTOR3, TYPE_VECTOR3I: return {"type": type_string(typeof(value)), "value": [value.x, value.y, value.z]}
        TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_QUATERNION: return {"type": type_string(typeof(value)), "value": [value.x, value.y, value.z, value.w]}
        TYPE_COLOR: return {"type": "Color", "value": [value.r, value.g, value.b, value.a]}
        TYPE_OBJECT:
            if value is Resource:
                return {"type": "Resource", "class": value.get_class(), "path": value.resource_path.left(4096)}
            if value is Node:
                return {"type": "Node", "path": str(value.get_path()).left(4096) if value.is_inside_tree() else str(value.name).left(4096)}
            return {"type": "Object"}
        TYPE_ARRAY, TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY, TYPE_PACKED_BYTE_ARRAY:
            var items = []
            for index in mini(value.size(), mini(100, limits.remaining)):
                items.append(encode(value[index], depth + 1, limits))
            return {"type": type_string(typeof(value)), "value": items, "truncated": value.size() > items.size()}
        TYPE_DICTIONARY:
            var entries = []
            for key in value:
                if entries.size() >= 100 or limits.remaining <= 1:
                    break
                entries.append({"key": encode(key, depth + 1, limits), "value": encode(value[key], depth + 1, limits)})
            return {"type": "Dictionary", "entries": entries, "truncated": value.size() > entries.size()}
        _: return {"type": type_string(typeof(value)), "unsupported": true}

static func decode(value, info):
    var expected = int(info.type)
    if value is Dictionary and value.has("type"):
        var tag = value.type
        if tag == "Resource" and expected == TYPE_OBJECT:
            if not value.get("path") is String or not value.path.begins_with("res://"):
                return {"ok": false, "error": "Resource requires a confined res:// path"}
            var resource = load(value.path)
            if not resource is Resource or resource is Script:
                return {"ok": false, "error": "Use attach_script for scripts; resource unavailable"}
            if info.hint == PROPERTY_HINT_RESOURCE_TYPE:
                var compatible = false
                for allowed in info.hint_string.split(","):
                    compatible = compatible or resource.is_class(allowed.strip_edges())
                if not compatible:
                    return {"ok": false, "error": "Incompatible resource class"}
            return {"ok": true, "value": resource}
        if tag != type_string(expected):
            return {"ok": false, "error": "Type tag does not match property"}
        value = value.get("value")
    var sizes = {TYPE_VECTOR2: 2, TYPE_VECTOR2I: 2, TYPE_VECTOR3: 3, TYPE_VECTOR3I: 3, TYPE_VECTOR4: 4, TYPE_VECTOR4I: 4, TYPE_QUATERNION: 4, TYPE_COLOR: 4}
    if sizes.has(expected):
        if not value is Array or value.size() != sizes[expected]:
            return {"ok": false, "error": "Wrong numeric component count"}
        for component in value:
            if not (component is float or component is int) or not is_finite(float(component)):
                return {"ok": false, "error": "Expected finite numeric components"}
            if expected in [TYPE_VECTOR2I, TYPE_VECTOR3I, TYPE_VECTOR4I] and component != int(component):
                return {"ok": false, "error": "Expected integer components"}
        match expected:
            TYPE_VECTOR2: value = Vector2(value[0], value[1])
            TYPE_VECTOR2I: value = Vector2i(value[0], value[1])
            TYPE_VECTOR3: value = Vector3(value[0], value[1], value[2])
            TYPE_VECTOR3I: value = Vector3i(value[0], value[1], value[2])
            TYPE_VECTOR4: value = Vector4(value[0], value[1], value[2], value[3])
            TYPE_VECTOR4I: value = Vector4i(value[0], value[1], value[2], value[3])
            TYPE_QUATERNION: value = Quaternion(value[0], value[1], value[2], value[3])
            TYPE_COLOR: value = Color(value[0], value[1], value[2], value[3])
    elif expected == TYPE_NODE_PATH and value is String:
        value = NodePath(value)
    elif expected == TYPE_STRING_NAME and value is String:
        value = StringName(value)
    elif expected == TYPE_INT and value is float and is_finite(value) and value == int(value):
        value = int(value)
    elif expected == TYPE_FLOAT and value is int:
        value = float(value)
    elif expected == TYPE_OBJECT and value == null:
        pass
    elif expected not in [TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH]:
        return {"ok": false, "error": "Unsupported property type; use a dedicated reference/resource tool"}
    if typeof(value) != expected and not (expected == TYPE_OBJECT and value == null):
        return {"ok": false, "error": "Incompatible property type"}
    if value is float and not is_finite(value):
        return {"ok": false, "error": "Expected finite number"}
    return {"ok": true, "value": value}
