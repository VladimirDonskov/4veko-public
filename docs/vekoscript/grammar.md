# VekoScript grammar (EBNF)

Notation: `{ x }` zero or more, `[ x ]` optional, `|` alternatives, terminals in quotes.

```ebnf
module          = { item } EOF ;
item            = catalogDecl | documentDecl | registerDecl
                | functionDecl | handlerDecl | statement ;

(* ---- metadata ---- *)
catalogDecl     = "catalog" IDENT "{" { fieldDecl } "}" ;
documentDecl    = "document" IDENT "{" { fieldDecl | rowsDecl } "}" ;
rowsDecl        = "rows" IDENT "{" { fieldDecl } "}" ;
registerDecl    = [ "information" ] "register" IDENT [ "periodic" ]
                  "{" { dimensionDecl | measureDecl | resourceDecl } "}" ;
fieldDecl       = "field" IDENT ":" typeRef { fieldModifier } ";" ;
dimensionDecl   = "dimension" IDENT ":" typeRef ";" ;
measureDecl     = "measure" IDENT ":" typeRef ";" ;          (* accumulation registers *)
resourceDecl    = "resource" IDENT ":" typeRef ";" ;         (* information registers *)
fieldModifier   = "required" | "unique" | "default" literal ;
typeRef         = "String" [ "(" INTEGER ")" ]
                | "Decimal" "(" INTEGER "," INTEGER ")"
                | "Integer" | "Boolean" | "Date" | "DateTime"
                | "Ref" "<" IDENT ">" ;

(* ---- logic ---- *)
functionDecl    = "function" IDENT "(" [ IDENT { "," IDENT } ] ")" block ;
handlerDecl     = "on" IDENT "." EVENT "(" IDENT ")" block ;
EVENT           = "BeforeCreate" | "AfterCreate" | "BeforeSave" | "AfterSave"
                | "BeforePost" | "Post" | "AfterPost"
                | "BeforeReverse" | "AfterReverse"
                | "BeforeDelete" | "AfterDelete" ;

block           = "{" { statement } "}" ;
statement       = "let" IDENT "=" expression ";"
                | "if" condition block [ "else" ( ifStatement | block ) ]
                | "while" condition block
                | "for" IDENT "in" condition block
                | "return" [ expression ] ";"
                | "break" ";" | "continue" ";"
                | target ( "=" | "+=" | "-=" ) expression ";"
                | expression ";" ;
ifStatement     = "if" condition block [ "else" ( ifStatement | block ) ] ;
condition       = expression ;      (* parsed without top-level map literals *)
target          = IDENT { "." IDENT | "[" expression "]" } ;

(* ---- expressions, lowest to highest precedence ---- *)
expression      = orExpr ;
orExpr          = andExpr { "||" andExpr } ;
andExpr         = equality { "&&" equality } ;
equality        = comparison { ( "==" | "!=" ) comparison } ;
comparison      = additive { ( "<" | "<=" | ">" | ">=" ) additive } ;
additive        = multiplicative { ( "+" | "-" ) multiplicative } ;
multiplicative  = unary { ( "*" | "/" | "%" ) unary } ;
unary           = ( "!" | "-" ) unary | postfix ;
postfix         = primary { "." IDENT | "[" expression "]" | arguments } ;
arguments       = "(" [ argument { "," argument } ] ")" ;
argument        = [ IDENT ":" ] expression ;   (* positional arguments before named ones *)
primary         = INTEGER | DECIMAL | STRING | "true" | "false" | "null"
                | IDENT | "(" expression ")"
                | "[" [ expression { "," expression } ] "]"
                | "{" [ mapEntry { "," mapEntry } ] "}" ;
mapEntry        = ( IDENT | STRING ) ":" expression ;
literal         = INTEGER | DECIMAL | STRING | "true" | "false" | "null" | "-" ( INTEGER | DECIMAL ) ;
```

Disambiguation rules:

1. In `if`, `while` and `for` headers a `{` always starts the block. Wrap a map literal in
   parentheses to use it there: `if (m) == ...`.
2. A statement may not start with `{`.
3. `Ref`, `String`, `Decimal` and the other type names are only special after `:` in metadata
   declarations; elsewhere they are ordinary identifiers.
4. Event names are contextual: they are checked after `on Type.`.
