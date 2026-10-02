# -*- coding: utf-8 -*-
"""
定义跳转 / 引用查找（Go-to-Definition & Find References）。

完全复用编译器既有的前端流水线：词法 -> 语法 -> 语义分析产出的**符号表与作用域链**，
因此同名遮蔽、形参与全局变量、函数调用与变量使用的区分都与语义分析保持一致，
本模块不再实现第二套名字解析，避免两处规则分叉。

语义分析器在解析每个名字时已经把使用点按角色记录下来：
    read   —— 变量 / 形参 / 函数名作为值被使用
    call   —— 函数（或内置函数）被调用
    assign —— 出现在赋值号左侧
定义点（函数名、形参名、var 声明的变量名）直接取符号表里记录的标识符行列号，
该位置在 parser 阶段按名字 token 精确保存（而非 var / func 关键字位置）。

输出结构（JSON 友好）：
    symbols    —— 每个已解析符号：定义位置 + 所属作用域 + 全部使用位置
    occurrences—— 按文档顺序排列的全部标识符出现点（定义 + 使用 + 未解析），
                  前端按 (line, column) 命中后即可给编辑器里的标识符着色/响应点击
    unresolved —— 未定义名字的使用点
"""

from . import lexer as lexer_mod
from . import parser as parser_mod
from . import semantic as semantic_mod
from . import symbols as sym
from . import diagnostics as diag

# 角色 -> 中文标签（前端也会再兜底一层）
ROLE_LABELS = {
    "declaration": "定义",
    "parameter": "形参",
    "read": "变量使用",
    "call": "函数调用",
    "assign": "赋值",
}

KIND_LABELS = {
    sym.KIND_VARIABLE: "变量",
    sym.KIND_PARAMETER: "形参",
    sym.KIND_FUNCTION: "函数",
    sym.KIND_BUILTIN: "内置函数",
}


def build_navigation(source: str):
    """构建导航数据。即使源码含语法/语义错误，也尽量返回已解析出的部分结果。"""
    result = {
        "ok": True,
        "has_errors": False,
        "symbols": [],
        "occurrences": [],
        "unresolved": [],
    }

    tokens, lex_diags = lexer_mod.tokenize(source)
    if lex_diags.has_errors:
        # 词法错误会让 token 流失真，名字解析不可靠：回传错误状态，前端降级为"仅当前词"
        result["ok"] = False
        result["has_errors"] = True
        result["stage"] = "lex"
        return result

    bag = diag.DiagnosticBag()
    tree = parser_mod.Parser(tokens, bag).parse()
    analyzer = semantic_mod.SemanticAnalyzer()
    analyzer.set_source(source)
    analyzer.analyze(tree)

    # 符号表 -> 视图（定义点直接取自符号记录的名字行列号；内置函数无源码定义）
    sym_by_sid = {}
    for s in analyzer.symbols.all_symbols():
        sym_by_sid[s.sid] = _symbol_view(s)

    # 语义阶段记录的使用点归入对应符号
    for u in analyzer.usages:
        view = sym_by_sid.get(u["sid"])
        if view is None:
            continue
        view["usages"].append({
            "line": u["line"], "column": u["column"],
            "role": u["role"], "role_label": ROLE_LABELS.get(u["role"], u["role"]),
        })

    result["unresolved"] = [dict(u) for u in analyzer.unresolved]
    result["has_errors"] = bag.has_errors

    symbols = list(sym_by_sid.values())
    for v in symbols:
        v["usages"].sort(key=lambda o: (o["line"], o["column"]))
        v["usage_count"] = len(v["usages"])
    symbols.sort(key=lambda v: (
        v["definition"]["line"] if v["definition"] else 10 ** 9,
        v["definition"]["column"] if v["definition"] else 0,
        v["name"],
    ))
    result["symbols"] = symbols

    # 全部出现点（定义 + 使用 + 未解析），供前端高亮 / 点击命中
    occurrences = []
    for v in symbols:
        d = v["definition"]
        if d:
            occurrences.append(_occ(v, d["line"], d["column"], d["role"], d["role_label"]))
        for u in v["usages"]:
            occurrences.append(_occ(v, u["line"], u["column"], u["role"], u["role_label"]))
    for u in result["unresolved"]:
        occurrences.append({
            "line": u["line"], "column": u["column"], "length": len(u["name"]),
            "name": u["name"], "sid": None, "kind": "unresolved",
            "resolved": False, "role": "unresolved", "role_label": "未定义",
        })
    occurrences.sort(key=lambda o: (o["line"], o["column"]))
    result["occurrences"] = occurrences
    return result


def _occ(view, line, column, role, role_label):
    return {
        "line": line, "column": column, "length": len(view["name"]),
        "name": view["name"], "sid": view["sid"], "kind": view["kind"],
        "resolved": True, "role": role, "role_label": role_label,
    }


def _symbol_view(s: sym.Symbol):
    is_builtin = s.kind == sym.KIND_BUILTIN
    scope = s.scope
    if is_builtin:
        definition = None
    else:
        role = "parameter" if s.kind == sym.KIND_PARAMETER else "declaration"
        definition = {
            "line": s.line, "column": s.column,
            "role": role, "role_label": ROLE_LABELS[role],
        }
    return {
        "sid": s.sid,
        "name": s.name,
        "kind": s.kind,
        "kind_label": KIND_LABELS.get(s.kind, s.kind),
        "is_builtin": is_builtin,
        "type": s.symbol_type,
        "scope_type": scope.scope_type if scope else "global",
        "scope_name": scope.name if scope else "global",
        "definition": definition,
        "usages": [],
        "usage_count": 0,
    }
