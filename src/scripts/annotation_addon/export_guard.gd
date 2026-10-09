@tool
extends EditorExportPlugin

func _get_name() -> String:
    return "GodotMCPAnnotationExportGuard"

func _export_file(path: String, _type: String, _features: PackedStringArray) -> void:
    if path.begins_with("res://addons/godot_mcp_annotations/") or path.begins_with("res://.godot-mcp/"):
        skip()
