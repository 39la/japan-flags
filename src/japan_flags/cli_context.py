from __future__ import annotations

import argparse
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .database import open_database


@dataclass(frozen=True)
class CliContext:
    data_directory: Path
    database_path: Path

    @classmethod
    def from_arguments(
        cls,
        arguments: argparse.Namespace,
        *,
        create_data_directory: bool = False,
    ) -> CliContext:
        data_directory = arguments.data_dir.resolve()
        if create_data_directory:
            data_directory.mkdir(parents=True, exist_ok=True)
        database = getattr(arguments, "database", None)
        database_path = (
            database.resolve() if database else data_directory / "japan-flags.sqlite"
        )
        return cls(data_directory=data_directory, database_path=database_path)

    def open_connection(self) -> sqlite3.Connection:
        return open_database(self.database_path)


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))
