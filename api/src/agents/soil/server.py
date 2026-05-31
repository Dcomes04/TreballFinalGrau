from mcp.server.fastmcp import FastMCP

from .router import register_tools

mcp = FastMCP("Soil Agent", host="0.0.0.0", port=8104)

register_tools(mcp)

if __name__ == "__main__":
    mcp.run(transport="streamable-http")
