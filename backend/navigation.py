# -*- coding: utf-8 -*-
"""
定义跳转与引用查找（Go to Definition / Find All References）。

完全复用编译器前端已有的词法、语法、语义三遍分析：语义分析会把每个标识符
表达式绑定到符号表条目（``Identifier.symbol``），声明节点也持有各自的符号
（``VarDecl.symbol`` / ``FunctionDecl.symbol`` / ``FunctionDecl.param_symbols``）。
本模块在此之上回答两个问题：

  * 光标处的标识符引用的是哪个符号？—— 沿作用域链解析的结果，因此同名遮蔽、
    形参与全局变量同名、函数调用与变量使用的区分都与编译器语义完全一致；
  * 这个符号的定义在哪里、在源码中有哪些使用位置（声明 / 读取 / 写入 / 调用）？

分析是容错的：即使源码暂时存在词法 / 语法错误（编辑过程中的常态），也会尽力
完成符号绑定，保证编辑器里随时可以跳转。
"""

from . import ast_nodes as ast
from . import lexer as lexer_mod
from . import parser as parser_mod
from . import semantic as semantic_mod
from . import symbols as sym
from . import tokens as T
from .diagnostics import DiagnosticBag

# 引用角色
ROLE_DECL = "decl"      # 声明点
ROLE_READ = "read"      # 读取
ROLE_WRITE = "write"    # 赋值写入
ROLE_CALL = "call"      # 函数调用


def definition_at(source, line, column):
    """解析 (line, column) 处标识符的定义位置与全部使用位置。

    行列均为 1-based；列采用光标（caret）语义：光标落在标识符首字符之前
    到末字符之后（含边界）都算命中。

    返回结构：
        found      —— 是否解析到符号
        name       —— 标识符文本
        message    —— 说明（未找到原因 / 内置函数提示）
        symbol     —— {name, kind, type, scope, scope_type} 或 None
        definition —— {line, column, length} 或 None（内置函数无源码定义）
        references —— [{line, column, length, role}]，按行列排序
    """
    tokens, program, _symbols = _analyze(source)
    tok = _ident_token_at(tokens, line, column)
    if tok is None:
        return {"found": False, "name": "", "message": "此处没有标识符",
                "symbol": None, "definition": None, "references": []}
    index = tokens.index(tok)
    target = (_declaration_symbol_at(tokens, program, index)
              or _identifier_symbol_at(program, tok))
    if target is None:
        return {"found": False, "name": tok.text,
                "message": f"未定义的标识符 '{tok.text}'",
                "symbol": None, "definition": None, "references": []}
    references = _collect_references(program, target)
    if target.kind == sym.KIND_BUILTIN:
        definition = None
        message = "内置函数，定义在语言运行时中"
    else:
        definition = {"line": target.line, "column": target.column,
                      "length": len(target.name)}
        message = ""
    return {
        "found": True,
        "name": target.name,
        "message": message,
        "symbol": {
            "name": target.name,
            "kind": target.kind,
            "type": target.symbol_type,
            "scope": target.scope.name,
            "scope_type": target.scope.scope_type,
        },
        "definition": definition,
        "references": references,
    }


# ---------------------------------------------------------------------------
# 分析入口（容错：词法/语法错误不阻断语义绑定）
# ---------------------------------------------------------------------------
def _analyze(source):
    """跑词法 / 语法 / 语义三遍，返回 (tokens, program, symbol_table)。"""
    tokens, _lex_diags = lexer_mod.tokenize(source)
    parser = parser_mod.Parser(tokens, DiagnosticBag())
    program = parser.parse()
    analyzer = semantic_mod.SemanticAnalyzer()
    analyzer.set_source(source)
    analyzer.analyze(program)
    return tokens, program, analyzer.symbols


def _ident_token_at(tokens, line, column):
    """定位 (line, column) 处的标识符 token（注释与字符串内不会产生 IDENT）。"""
    for tok in tokens:
        if tok.type != T.IDENT or tok.line != line:
            continue
        if tok.column <= column <= tok.column + len(tok.text):
            return tok
    return None


# ---------------------------------------------------------------------------
# AST 遍历
# ---------------------------------------------------------------------------
def _iter_statements(program):
    """产出所有语句 / 函数声明节点（含嵌套块、for 头、函数体，不展开表达式）。"""
    stack = list(program.declarations)
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, ast.FunctionDecl):
            stack.append(node.body)
        elif isinstance(node, ast.Block):
            stack.extend(node.statements)
        elif isinstance(node, ast.IfStmt):
            for _cond, body in node.branches:
                stack.append(body)
            if node.else_block:
                stack.append(node.else_block)
        elif isinstance(node, ast.WhileStmt):
            stack.append(node.body)
        elif isinstance(node, ast.ForStmt):
            if node.init is not None:
                stack.append(node.init)
            stack.append(node.body)


def _each_expr(program):
    """产出 AST 中所有表达式节点（先父后子）。"""
    def rec_expr(e):
        if e is None:
            return
        yield e
        if isinstance(e, ast.AssignStmt):
            # for 循环的增量位置可以是赋值语句
            yield from rec_expr(e.target)
            yield from rec_expr(e.value)
        elif isinstance(e, ast.UnaryExpr):
            yield from rec_expr(e.operand)
        elif isinstance(e, (ast.BinaryExpr, ast.LogicalExpr)):
            yield from rec_expr(e.left)
            yield from rec_expr(e.right)
        elif isinstance(e, ast.CallExpr):
            yield from rec_expr(e.callee)
            for a in e.args:
                yield from rec_expr(a)
        elif isinstance(e, ast.IndexExpr):
            yield from rec_expr(e.target)
            yield from rec_expr(e.index)
        elif isinstance(e, ast.ListLiteral):
            for x in e.elements:
                yield from rec_expr(x)

    def rec_stmt(s):
        if s is None:
            return
        if isinstance(s, ast.FunctionDecl):
            yield from rec_stmt(s.body)
        elif isinstance(s, ast.Block):
            for st in s.statements:
                yield from rec_stmt(st)
        elif isinstance(s, ast.VarDecl):
            yield from rec_expr(s.initializer)
        elif isinstance(s, ast.AssignStmt):
            yield from rec_expr(s.target)
            yield from rec_expr(s.value)
        elif isinstance(s, ast.ExprStmt):
            yield from rec_expr(s.expr)
        elif isinstance(s, ast.PrintStmt):
            for a in s.args:
                yield from rec_expr(a)
        elif isinstance(s, ast.IfStmt):
            for cond, body in s.branches:
                yield from rec_expr(cond)
                yield from rec_stmt(body)
            if s.else_block:
                yield from rec_stmt(s.else_block)
        elif isinstance(s, ast.WhileStmt):
            yield from rec_expr(s.condition)
            yield from rec_stmt(s.body)
        elif isinstance(s, ast.ForStmt):
            yield from rec_stmt(s.init)
            yield from rec_expr(s.condition)
            yield from rec_expr(s.increment)
            yield from rec_stmt(s.body)
        elif isinstance(s, ast.ReturnStmt):
            yield from rec_expr(s.value)

    for decl in program.declarations:
        yield from rec_stmt(decl)


def _find_decl(program, node_type, line, column):
    """按节点位置（var / func 关键字处）查找声明节点。"""
    for node in _iter_statements(program):
        if isinstance(node, node_type) and node.line == line and node.column == column:
            return node
    return None


# ---------------------------------------------------------------------------
# 符号解析：声明点 / 引用点
# ---------------------------------------------------------------------------
def _declaration_symbol_at(tokens, program, index):
    """若 tokens[index] 位于声明点（var 变量名 / func 函数名 / 形参名），
    返回对应符号，否则返回 None。"""
    tok = tokens[index]
    prev = tokens[index - 1] if index > 0 else None
    if prev is None:
        return None
    # var <name> —— 变量声明
    if prev.type == T.KW_VAR:
        decl = _find_decl(program, ast.VarDecl, prev.line, prev.column)
        return getattr(decl, "symbol", None) if decl else None
    # func <name> —— 函数声明
    if prev.type == T.KW_FUNC:
        decl = _find_decl(program, ast.FunctionDecl, prev.line, prev.column)
        return getattr(decl, "symbol", None) if decl else None
    # func f( <name> , ... ) —— 形参声明
    if prev.type in (T.LPAREN, T.COMMA):
        fn = _param_list_owner(tokens, index, program)
        if fn is not None:
            for s in getattr(fn, "param_symbols", None) or []:
                if s.name == tok.text:
                    return s
    return None


def _param_list_owner(tokens, index, program):
    """判断 tokens[index] 是否位于某个函数声明的形参列表中，是则返回该节点。"""
    depth = 0
    i = index - 1
    while i >= 0:
        t = tokens[i]
        if t.type == T.RPAREN:
            depth += 1
        elif t.type == T.LPAREN:
            if depth == 0:
                # 形如 func <name> ( ... ) 才是形参列表（区别于调用表达式）
                if i >= 2 and tokens[i - 1].type == T.IDENT \
                        and tokens[i - 2].type == T.KW_FUNC:
                    kw = tokens[i - 2]
                    return _find_decl(program, ast.FunctionDecl, kw.line, kw.column)
                return None
            depth -= 1
        i -= 1
    return None


def _identifier_symbol_at(program, tok):
    """在 AST 中找到与 token 对应的标识符表达式节点，返回其绑定的符号。"""
    for e in _each_expr(program):
        if (isinstance(e, ast.Identifier) and e.line == tok.line
                and e.column == tok.column):
            return e.symbol
    return None


# ---------------------------------------------------------------------------
# 引用收集
# ---------------------------------------------------------------------------
def _collect_references(program, target):
    """收集 target 符号在源码中的全部使用位置（含声明点），按行列排序。"""
    refs = []
    seen = set()

    def add(line, column, length, role):
        key = (line, column, role)
        if key in seen:
            return
        seen.add(key)
        refs.append({"line": line, "column": column, "length": length, "role": role})

    # 1) 声明点（变量 / 函数 / 形参；内置函数无源码声明点）
    for node in _iter_statements(program):
        if isinstance(node, ast.VarDecl) and node.symbol is target:
            add(node.name_line, node.name_column, len(node.name), ROLE_DECL)
        elif isinstance(node, ast.FunctionDecl):
            if node.symbol is target:
                add(node.name_line, node.name_column, len(node.name), ROLE_DECL)
            for s in getattr(node, "param_symbols", None) or []:
                if s is target:
                    add(s.line, s.column, len(s.name), ROLE_DECL)

    # 2) 区分写入（赋值目标）与调用（被调用的标识符）
    write_targets = set()
    call_callees = set()
    for node in _iter_statements(program):
        if isinstance(node, ast.AssignStmt) and isinstance(node.target, ast.Identifier):
            write_targets.add(id(node.target))
    for e in _each_expr(program):
        if isinstance(e, ast.CallExpr) and isinstance(e.callee, ast.Identifier):
            call_callees.add(id(e.callee))
        elif isinstance(e, ast.AssignStmt) and isinstance(e.target, ast.Identifier):
            write_targets.add(id(e.target))

    # 3) 使用点
    for e in _each_expr(program):
        if not isinstance(e, ast.Identifier) or e.symbol is not target:
            continue
        role = ROLE_READ
        if id(e) in write_targets:
            role = ROLE_WRITE
        elif id(e) in call_callees:
            role = ROLE_CALL
        add(e.line, e.column, len(e.name), role)

    refs.sort(key=lambda r: (r["line"], r["column"]))
    return refs
