from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path

from japan_flags.cli_context import CliContext


class CliContextTest(unittest.TestCase):
    def test_resolves_default_database_below_data_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_directory = Path(temporary_directory) / "data"
            context = CliContext.from_arguments(
                argparse.Namespace(data_dir=data_directory, database=None),
                create_data_directory=True,
            )

            self.assertEqual(context.data_directory, data_directory.resolve())
            self.assertEqual(
                context.database_path,
                data_directory.resolve() / "japan-flags.sqlite",
            )
            self.assertTrue(data_directory.is_dir())

    def test_preserves_an_explicit_database_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            database_path = root / "custom.sqlite"
            context = CliContext.from_arguments(
                argparse.Namespace(data_dir=root / "data", database=database_path),
            )

            self.assertEqual(context.database_path, database_path.resolve())


if __name__ == "__main__":
    unittest.main()
