"""Novela icon v5: black turtle silhouette (flaticon ref) on a green tile."""
from PIL import Image, ImageDraw, ImageOps

SIZE = 512
GREEN = (34, 163, 74, 255)

ref = Image.open("assets/turtle-ref.png").convert("RGBA")
# trim transparent margins
bbox = ref.split()[3].getbbox()
turtle = ref.crop(bbox)
# fit into tile with padding
pad = 96
turtle.thumbnail((SIZE - pad * 2, SIZE - pad * 2), Image.LANCZOS)
# force pure black glyph (keep antialiased alpha)
black = Image.new("RGBA", turtle.size, (0, 0, 0, 255))
black.putalpha(turtle.split()[3])

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=116, fill=GREEN)
img.alpha_composite(black, ((SIZE - turtle.width) // 2, (SIZE - turtle.height) // 2))

img.save("assets/icon.png")
img.save("assets/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# NSIS sidebar bitmap 164x314
side = Image.new("RGB", (164, 314), (25, 25, 25))
glyph = img.resize((120, 120), Image.LANCZOS)
side.paste(glyph, (22, 30), glyph)
dr = ImageDraw.Draw(side)
dr.text((22, 162), "Novela", fill=(208, 188, 255))
dr.text((22, 182), "Luau", fill=(160, 160, 160))
dr.text((22, 197), "obfuscator", fill=(160, 160, 160))
dr.text((22, 227), "v1.2.0", fill=(120, 120, 120))
side.save("assets/installerSidebar.bmp")
print("icon v5 + sidebar written")
