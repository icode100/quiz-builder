(function (root) {
  "use strict";

  const MAX_LENGTH = 1024;
  const MAX_TOKENS = 512;
  const MAX_DEPTH = 64;
  const MAX_COMBINATORIC_N = 10000;

  function finite(value) {
    if (!Number.isFinite(value)) throw new Error("Result is outside the finite real-number range.");
    return Object.is(value, -0) ? 0 : value;
  }

  function positive(value, name) {
    if (value <= 0) throw new Error(name + " needs a positive argument.");
    return value;
  }

  function power(base, exponent) {
    if (base === 0 && exponent <= 0) throw new Error("Zero needs a positive exponent.");
    if (base < 0 && !Number.isInteger(exponent)) {
      throw new Error("A negative base needs an integer exponent; use root for odd roots.");
    }
    return finite(Math.pow(base, exponent));
  }

  function factorial(value) {
    if (!Number.isInteger(value) || value < 0 || value > 170) {
      throw new Error("Factorial needs an integer from 0 to 170.");
    }
    let result = 1;
    for (let i = 2; i <= value; i += 1) result *= i;
    return finite(result);
  }

  function combinatoric(n, r, choose) {
    if (!Number.isInteger(n) || !Number.isInteger(r) || n < 0 || r < 0 || r > n || n > MAX_COMBINATORIC_N) {
      throw new Error("nCr/nPr need integers with 0 ≤ r ≤ n ≤ 10000.");
    }
    const count = choose ? Math.min(r, n - r) : r;
    let result = 1;
    for (let i = 1; i <= count; i += 1) {
      if (choose && Number.isSafeInteger(result)) {
        const numerator = n - count + i;
        let a = numerator, b = i;
        while (b) { const remainder = a % b; a = b; b = remainder; }
        // Cancel the fraction first: its remaining denominator divides the
        // previous integer result, preserving exact safe-integer combinations.
        result = finite((result / (i / a)) * (numerator / a));
      } else {
        result = finite(result * (choose ? (n - count + i) / i : n - i + 1));
      }
    }
    return result;
  }

  function tokenize(expression) {
    const tokens = [];
    let position = 0;
    while (position < expression.length) {
      const rest = expression.slice(position);
      if (/^\s/.test(rest)) {
        position += 1;
        continue;
      }
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
      const name = /^[a-zA-Z][a-zA-Z0-9]*/.exec(rest);
      let token;
      if (number) {
        if (/^[eE][+-]/.test(rest.slice(number[0].length))) {
          throw new Error("Invalid scientific notation; an exponent needs digits.");
        }
        token = { type: "number", value: finite(Number(number[0])) };
        position += number[0].length;
      } else if (name) {
        token = { type: "name", value: name[0].toLowerCase() };
        position += name[0].length;
      } else if (rest[0] === "π") {
        token = { type: "name", value: "pi" };
        position += 1;
      } else if ("+-*/%^!(),".includes(rest[0])) {
        token = { type: rest[0] };
        position += 1;
      } else {
        throw new Error("Unsupported character at position " + (position + 1) + ".");
      }
      tokens.push(token);
      if (tokens.length > MAX_TOKENS) throw new Error("Expression has too many terms (maximum 512 tokens).");
    }
    tokens.push({ type: "end" });
    return tokens;
  }

  function evaluate(expression, options = {}) {
    if (typeof expression !== "string") throw new Error("Enter an expression.");
    if (expression.length > MAX_LENGTH) throw new Error("Expression is too long (maximum 1024 characters).");
    if (!expression.trim()) throw new Error("Enter an expression.");
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid calculator settings.");
    const { angleMode = "DEG", ans = 0, memory = 0 } = options;
    if (angleMode !== "DEG" && angleMode !== "RAD") throw new Error("Angle mode must be DEG or RAD.");
    if (typeof ans !== "number" || !Number.isFinite(ans) || typeof memory !== "number" || !Number.isFinite(memory)) {
      throw new Error("Answer and memory must be finite numbers.");
    }

    const radians = value => angleMode === "DEG" ? (value % 360) * Math.PI / 180 : value;
    const fromRadians = value => angleMode === "DEG" ? value * 180 / Math.PI : value;
    const functions = {
      sqrt: [1, value => {
        if (value < 0) throw new Error("Square root needs a nonnegative argument.");
        return Math.sqrt(value);
      }],
      cbrt: [1, Math.cbrt],
      abs: [1, Math.abs],
      ln: [1, value => Math.log(positive(value, "ln"))],
      log: [1, value => Math.log10(positive(value, "log"))],
      log2: [1, value => Math.log2(positive(value, "log2"))],
      exp: [1, Math.exp],
      sin: [1, value => Math.sin(radians(value))],
      cos: [1, value => Math.cos(radians(value))],
      tan: [1, value => {
        const angle = radians(value);
        // Reject poles that floating-point pi otherwise turns into huge finite values.
        if (Math.abs(Math.cos(angle)) <= 1e-15) throw new Error("tan is undefined at this angle.");
        return Math.tan(angle);
      }],
      asin: [1, value => {
        if (Math.abs(value) > 1) throw new Error("asin needs an argument from -1 to 1.");
        return fromRadians(Math.asin(value));
      }],
      acos: [1, value => {
        if (Math.abs(value) > 1) throw new Error("acos needs an argument from -1 to 1.");
        return fromRadians(Math.acos(value));
      }],
      atan: [1, value => fromRadians(Math.atan(value))],
      sinh: [1, Math.sinh],
      cosh: [1, Math.cosh],
      tanh: [1, Math.tanh],
      floor: [1, Math.floor],
      ceil: [1, Math.ceil],
      pow: [2, power],
      root: [2, (value, degree) => {
        if (degree === 0) throw new Error("Root degree must be nonzero.");
        if (value < 0) {
          if (!Number.isInteger(degree) || Math.abs(degree % 2) !== 1) {
            throw new Error("A negative value needs an odd integer root degree.");
          }
          return -Math.pow(-value, 1 / degree);
        }
        if (value === 0 && degree < 0) throw new Error("Zero needs a positive root degree.");
        return Math.pow(value, 1 / degree);
      }],
      ncr: [2, (n, r) => combinatoric(n, r, true)],
      npr: [2, (n, r) => combinatoric(n, r, false)]
    };
    const constants = { pi: Math.PI, e: Math.E, ans, mem: memory };
    const tokens = tokenize(expression);
    let position = 0;
    let depth = 0;
    const current = () => tokens[position];
    const take = type => {
      if (current().type !== type) return false;
      position += 1;
      return true;
    };
    const requireToken = type => {
      if (!take(type)) throw new Error("Expected '" + type + "'.");
    };

    function sum() {
      let value = product();
      while (current().type === "+" || current().type === "-") {
        const operation = tokens[position++].type;
        const right = product();
        value = finite(operation === "+" ? value + right : value - right);
      }
      return value;
    }

    function product() {
      let value = unary();
      while (true) {
        const operation = current().type;
        const implicit = operation === "(" || operation === "name";
        if (!implicit && operation !== "*" && operation !== "/" && operation !== "%") break;
        if (!implicit) position += 1;
        const right = unary();
        if ((operation === "/" || operation === "%") && right === 0) throw new Error("Cannot divide by zero.");
        value = finite(operation === "/" ? value / right : operation === "%" ? value % right : value * right);
      }
      return value;
    }

    function unary() {
      depth += 1;
      if (depth > MAX_DEPTH) throw new Error("Expression is nested too deeply (maximum 64 levels).");
      try {
        if (take("+")) return unary();
        if (take("-")) return finite(-unary());
        let value = primary();
        while (take("!")) value = factorial(value);
        if (take("^")) value = power(value, unary());
        return value;
      } finally {
        depth -= 1;
      }
    }

    function primary() {
      const token = current();
      if (take("number")) return token.value;
      if (take("(")) {
        const value = sum();
        requireToken(")");
        return value;
      }
      if (take("name")) {
        if (Object.prototype.hasOwnProperty.call(constants, token.value)) return constants[token.value];
        if (!Object.prototype.hasOwnProperty.call(functions, token.value)) throw new Error("Unknown name: " + token.value + ".");
        const [arity, calculate] = functions[token.value];
        requireToken("(");
        const args = [sum()];
        while (take(",")) {
          if (args.length >= arity) throw new Error(token.value + " needs " + arity + " argument(s).");
          args.push(sum());
        }
        requireToken(")");
        if (args.length !== arity) throw new Error(token.value + " needs " + arity + " argument(s).");
        return finite(calculate(...args));
      }
      throw new Error("Expected a number, constant, function, or '('.");
    }

    const result = sum();
    if (current().type !== "end") throw new Error("Unexpected input; check operators and parentheses.");
    return finite(result);
  }

  const api = Object.freeze({ evaluate });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.QuizCalculatorEngine = api;
})(typeof window === "object" ? window : null);
