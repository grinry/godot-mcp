extends SceneTree

func _initialize() -> void:
    call_deferred("start_game")

func start_game() -> void:
    # Godot loads --scene (or the configured main scene) before deferred startup.
    # Only load manually when this wrapper was invoked without an engine scene.
    if current_scene == null:
        var scene_path = ""
        for argument in OS.get_cmdline_user_args():
            if argument.begins_with("--godot-mcp-annotation-scene="):
                scene_path = argument.trim_prefix("--godot-mcp-annotation-scene=")
        if scene_path.is_empty():
            scene_path = ProjectSettings.get_setting("application/run/main_scene", "")
        var packed = load(scene_path) if not scene_path.is_empty() else null
        if not packed is PackedScene:
            push_error("MCP annotations: cannot load the requested game scene.")
            quit(1)
            return
        var scene = packed.instantiate()
        root.add_child(scene)
        current_scene = scene
    root.add_child(preload("runtime.tscn").instantiate())
