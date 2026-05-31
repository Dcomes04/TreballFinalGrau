from mcp.server.fastmcp import FastMCP

from .router import register_tools

mcp = FastMCP("Simulation Agent", host="0.0.0.0", port=8103)

register_tools(mcp)

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
