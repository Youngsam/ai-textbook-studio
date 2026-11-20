"""Structural checks for LaTeX in translated Markdown.

A single missing `$` makes the renderer pair every later delimiter wrongly, so
broken paragraphs are found here and sent back to the model for repair.
"""

import re

PARAGRAPH = re.compile(r"\n[ \t]*\n")
DISPLAY = re.compile(r"\$\$(.+?)\$\$", re.S)
INLINE_CODE = re.compile(r"`+[^`\n]*`+")
# A `$` not escaped by a backslash.
DOLLAR = re.compile(r"(?<!\\)\$")
TEXT_GROUP = re.compile(r"\\(?:text|textrm|textbf|textit|mathrm|mbox|operatorname)\s*\{[^{}]*\}")
HANGUL = re.compile(r"[\uac00-\ud7a3]")


def paragraphs(markdown: str):
    """Split on blank lines while keeping fenced code blocks whole."""
    blocks, fence = [], None
    for block in PARAGRAPH.split(markdown):
        if fence is not None:
            fence += "\n\n" + block
            if block.rstrip().endswith(("```", "~~~")):
                blocks.append(fence)
                fence = None
            continue
        stripped = block.lstrip()
        if stripped.startswith(("```", "~~~")) and not (
            len(stripped) > 3 and stripped.rstrip().endswith(stripped[:3]) and "\n" in stripped
        ):
            fence = block
            continue
        blocks.append(block)
    if fence is not None:
        blocks.append(fence)
    return blocks


def formula_problems(formula: str):
    problems = []
    plain = formula.replace("\\{", "").replace("\\}", "")
    if plain.count("{") != plain.count("}"):
        problems.append("중괄호 짝이 맞지 않음")
    if len(re.findall(r"\\left(?![a-zA-Z])", formula)) != len(
        re.findall(r"\\right(?![a-zA-Z])", formula)
    ):
        problems.append("\\left/\\right 짝이 맞지 않음")
    if len(re.findall(r"\\begin\{", formula)) != len(re.findall(r"\\end\{", formula)):
        problems.append("\\begin/\\end 짝이 맞지 않음")
    if HANGUL.search(TEXT_GROUP.sub("", formula)):
        problems.append("수식 안에 한국어 문장이 섞임")
    return problems


def paragraph_problems(paragraph: str):
    stripped = paragraph.lstrip()
    if stripped.startswith(("```", "~~~")):
        return []
    text = INLINE_CODE.sub("", paragraph)
    problems = []
    if text.count("$$") % 2:
        problems.append("$$ 짝이 맞지 않음")
    for formula in DISPLAY.findall(text):
        problems += formula_problems(formula)
    text = DISPLAY.sub(" ", text)
    dollars = [match.start() for match in DOLLAR.finditer(text)]
    if len(dollars) % 2:
        problems.append("$ 짝이 맞지 않음")
    else:
        for start, end in zip(dollars[::2], dollars[1::2]):
            problems += formula_problems(text[start + 1 : end])
    return list(dict.fromkeys(problems))


def broken_paragraphs(markdown: str):
    """Return (index, paragraph, problems) for paragraphs whose math would not render."""
    return [
        (index, paragraph, problems)
        for index, paragraph in enumerate(paragraphs(markdown))
        if (problems := paragraph_problems(paragraph))
    ]
