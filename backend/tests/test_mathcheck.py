from app.mathcheck import broken_paragraphs, paragraphs

VALID = r"""스칼라의 경우와 유사하게 다음을 얻는다.

$$
p_y(\mathbf{y})=p_x\bigl(g(\mathbf{y})\bigr)\left|\det\left[\mathbf{J}_g(\mathbf{y})\right]\right| \tag{2.156}
$$

여기서 $\mathbf{J}_g = \frac{dg(\mathbf{y})}{d\mathbf{y}^T}$이고 $x \text{가 양수}$이다.

초기 가격이 \$40인 주식. 코드 `a $ b`도 그대로 둔다.

```python
price = "$"

total = 1
```"""


def test_valid_math_currency_and_code_are_not_flagged():
    assert broken_paragraphs(VALID) == []
    assert len(paragraphs(VALID)) == 5


def test_missing_dollar_from_real_translation_is_flagged():
    caption = (
        r"그림 2.20: 아핀 변환 $f(\mathbf{x})=\mathbf{A}\mathbf{x}+\mathbf{b)의 예. "
        r"(a) 여기서는 $\mathbf{A}=\mathbf{I}$이다. (b) 여기서는 $\mathbf{b}=0$이다."
    )
    broken = broken_paragraphs(f"첫 문단.\n\n{caption}\n\n끝.")
    assert [(index, problems) for index, _, problems in broken] == [(1, ["$ 짝이 맞지 않음"])]


def test_formula_structure_problems():
    cases = {
        r"$$\frac{a}{b$$": "중괄호 짝이 맞지 않음",
        r"$\left( x$": "\\left/\\right 짝이 맞지 않음",
        r"$\begin{matrix} a$": "\\begin/\\end 짝이 맞지 않음",
        r"$x는 y$": "수식 안에 한국어 문장이 섞임",
        "$$\nx\n": "$$ 짝이 맞지 않음",
    }
    for source, problem in cases.items():
        assert problem in broken_paragraphs(source)[0][2], source
