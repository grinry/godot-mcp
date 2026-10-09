@tool
extends Control

signal region_selected(region: Dictionary)

var image: Image
var texture: ImageTexture
var marks: Array = []
var draft_region: Dictionary = {}
var draft_kind = "rectangle"
var kind = "rectangle"
var dragging = false
var start = Vector2.ZERO
var finish = Vector2.ZERO

func set_image(value: Image) -> void:
    image = value
    texture = ImageTexture.create_from_image(value)
    marks.clear()
    draft_region.clear()
    dragging = false
    queue_redraw()

func image_rect() -> Rect2:
    if image == null:
        return Rect2()
    var dimensions = Vector2(image.get_size())
    var scale_factor = minf(size.x / dimensions.x, size.y / dimensions.y)
    var drawn = dimensions * scale_factor
    return Rect2((size - drawn) / 2.0, drawn)

func _gui_input(event: InputEvent) -> void:
    if image == null:
        return
    var rect = image_rect()
    if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
        if event.pressed and rect.has_point(event.position):
            start = (event.position - rect.position) / rect.size
            finish = start
            dragging = true
        elif not event.pressed and dragging:
            finish = ((event.position - rect.position) / rect.size).clamp(Vector2.ZERO, Vector2.ONE)
            dragging = false
            var minimum = start.min(finish)
            var extent = start.max(finish) - minimum
            if kind == "pin":
                minimum = start
                extent = Vector2.ZERO
            elif extent.x < 0.002 or extent.y < 0.002:
                queue_redraw()
                accept_event()
                return
            draft_region = {"x": minimum.x, "y": minimum.y, "width": extent.x, "height": extent.y}
            draft_kind = kind
            region_selected.emit(draft_region)
        accept_event()
        queue_redraw()
    elif event is InputEventMouseMotion and dragging:
        finish = ((event.position - rect.position) / rect.size).clamp(Vector2.ZERO, Vector2.ONE)
        accept_event()
        queue_redraw()

func _draw() -> void:
    draw_rect(Rect2(Vector2.ZERO, size), Color(0.07, 0.08, 0.10))
    if texture == null:
        return
    var rect = image_rect()
    draw_texture_rect(texture, rect, false)
    var font = ThemeDB.fallback_font
    for index in marks.size():
        var mark = marks[index]
        var region = mark.region
        var point = rect.position + Vector2(region.x, region.y) * rect.size
        if mark.kind == "pin":
            draw_circle(point, 6.0, Color.ORANGE_RED)
        else:
            draw_rect(Rect2(point, Vector2(region.width, region.height) * rect.size), Color.ORANGE_RED, false, 3.0)
        draw_string(font, point + Vector2(3, 18), str(index + 1), HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color.ORANGE_RED)
    if dragging:
        if kind == "pin":
            draw_circle(rect.position + start * rect.size, 6.0, Color.YELLOW)
        else:
            draw_rect(Rect2(rect.position + start.min(finish) * rect.size, (start.max(finish) - start.min(finish)) * rect.size), Color.YELLOW, false, 2)
    elif not draft_region.is_empty():
        var point = rect.position + Vector2(draft_region.x, draft_region.y) * rect.size
        if draft_kind == "pin":
            draw_circle(point, 6.0, Color.YELLOW)
        else:
            draw_rect(Rect2(point, Vector2(draft_region.width, draft_region.height) * rect.size), Color.YELLOW, false, 2)

func _notification(what: int) -> void:
    if what == NOTIFICATION_RESIZED:
        queue_redraw()

func marked_image() -> Image:
    var result = image.duplicate() as Image
    result.convert(Image.FORMAT_RGBA8)
    var dimensions = Vector2(result.get_size())
    # Tiny bitmap numbers keep the saved marks deterministic and renderer-independent.
    var digits = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"]
    for index in marks.size():
        var mark = marks[index]
        var region = mark.region
        var point = Vector2i(Vector2(region.x, region.y) * dimensions)
        var end = Vector2i(Vector2(region.x + region.width, region.y + region.height) * dimensions)
        var bounds = Rect2i(Vector2i.ZERO, result.get_size())
        if mark.kind == "pin":
            result.fill_rect(Rect2i(point - Vector2i(4, 4), Vector2i(9, 9)).intersection(bounds), Color.ORANGE_RED)
        else:
            for border in [Rect2i(point, Vector2i(maxi(end.x - point.x, 1), 3)), Rect2i(Vector2i(point.x, end.y - 3), Vector2i(maxi(end.x - point.x, 1), 3)), Rect2i(point, Vector2i(3, maxi(end.y - point.y, 1))), Rect2i(Vector2i(end.x - 3, point.y), Vector2i(3, maxi(end.y - point.y, 1)))]:
                result.fill_rect(border.intersection(bounds), Color.ORANGE_RED)
        var label_point = Vector2i(clampi(point.x + 4, 0, maxi(result.get_width() - 32, 0)), clampi(point.y + 4, 0, maxi(result.get_height() - 20, 0)))
        var characters = str(index + 1)
        for character_index in characters.length():
            var glyph = digits[int(characters[character_index])]
            for pixel in glyph.length():
                if glyph[pixel] == "1":
                    var offset = Vector2i(character_index * 12 + (pixel % 3) * 3, (pixel / 3) * 3)
                    result.fill_rect(Rect2i(label_point + offset, Vector2i(3, 3)).intersection(bounds), Color.ORANGE_RED)
    return result
